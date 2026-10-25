// Voyage AI embeddings (https://docs.voyageai.com/reference/embeddings-api).
// voyage-3.5 produces 1024 dimensions natively and distinguishes documents from queries.
import { assertDimensions, EMBEDDING_DIMENSIONS, type EmbeddingProvider, type InputType, type ProviderDeps } from "./types.ts";
import { batchTexts, postJsonWithRetry } from "./http.ts";
import { estimateTokens } from "./tokens.ts";

export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

// List prices (USD per million tokens) at the time of writing, for estimates only.
const PRICES: Record<string, number> = {
  "voyage-3.5": 0.06,
  "voyage-3.5-lite": 0.02,
  "voyage-3-large": 0.18,
  "voyage-3": 0.06,
  "voyage-3-lite": 0.02,
};
// Models that accept output_dimension (needed only when the model's default is not 1024).
const DEFAULT_DIMS: Record<string, number> = { "voyage-3.5": 1024, "voyage-3.5-lite": 1024, "voyage-3-large": 1024, "voyage-3": 1024, "voyage-3-lite": 512 };

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly model: string;
  readonly usdPerMillionTokens: number;
  private readonly url: string;
  /** Tokens the provider reported, for callers that want the real count. */
  reportedTokens = 0;

  constructor(
    private readonly opts: { apiKey: string; model: string; url?: string },
    private readonly deps: ProviderDeps,
  ) {
    this.model = opts.model;
    this.url = opts.url ?? VOYAGE_URL;
    this.usdPerMillionTokens = PRICES[opts.model] ?? 0.06;
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    // Voyage caps a request at 1,000 texts and (for voyage-3.5) 320k tokens; stay well under both.
    for (const batch of batchTexts(texts, estimateTokens, 64, 100_000)) {
      const body: Record<string, unknown> = { input: batch, model: this.model, input_type: inputType, truncation: true };
      if ((DEFAULT_DIMS[this.model] ?? 1024) !== this.dimensions) body.output_dimension = this.dimensions;
      const res = await postJsonWithRetry<VoyageResponse>(this.url, body, { authorization: `Bearer ${this.opts.apiKey}` }, this.deps);
      const rows = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== batch.length) throw new Error(`voyage returned ${rows.length} embeddings for ${batch.length} texts`);
      const vectors = rows.map((r) => r.embedding);
      assertDimensions(vectors, this.dimensions, "voyage");
      out.push(...vectors);
      this.reportedTokens += res.usage?.total_tokens ?? 0;
    }
    return out;
  }
}
