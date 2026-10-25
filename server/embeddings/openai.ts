// OpenAI embeddings (text-embedding-3-small / -large) with dimensions=1024.
import { assertDimensions, EMBEDDING_DIMENSIONS, type EmbeddingProvider, type InputType, type ProviderDeps } from "./types.ts";
import { batchTexts, postJsonWithRetry } from "./http.ts";
import { estimateTokens } from "./tokens.ts";

export const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const PRICES: Record<string, number> = { "text-embedding-3-small": 0.02, "text-embedding-3-large": 0.13 };

interface OpenAIResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly model: string;
  readonly usdPerMillionTokens: number;
  private readonly url: string;
  reportedTokens = 0;

  constructor(
    private readonly opts: { apiKey: string; model: string; url?: string },
    private readonly deps: ProviderDeps,
  ) {
    this.model = opts.model;
    this.url = opts.url ?? OPENAI_URL;
    this.usdPerMillionTokens = PRICES[opts.model] ?? 0.02;
  }

  async embed(texts: string[], _inputType: InputType): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (const batch of batchTexts(texts, estimateTokens, 64, 100_000)) {
      const res = await postJsonWithRetry<OpenAIResponse>(
        this.url,
        { input: batch, model: this.model, dimensions: this.dimensions, encoding_format: "float" },
        { authorization: `Bearer ${this.opts.apiKey}` },
        this.deps,
      );
      const rows = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== batch.length) throw new Error(`openai returned ${rows.length} embeddings for ${batch.length} texts`);
      const vectors = rows.map((r) => r.embedding);
      assertDimensions(vectors, this.dimensions, "openai");
      out.push(...vectors);
      this.reportedTokens += res.usage?.total_tokens ?? 0;
    }
    return out;
  }
}
