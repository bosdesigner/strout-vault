// Embedding provider contract. Kept free of imports so providers and the factory can both
// depend on it without a cycle.

export const EMBEDDING_DIMENSIONS = 1024;

export type InputType = "document" | "query";

export interface EmbeddingProvider {
  /** voyage | openai | fake */
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** List price in USD per million input tokens, for estimates and the dry run. */
  readonly usdPerMillionTokens: number;
  /**
   * Embeds texts in order. `inputType` lets asymmetric models (Voyage) embed stored
   * passages and search queries differently; providers without the notion ignore it.
   * Batches, retries with backoff on 429/5xx and never returns fewer vectors than texts.
   */
  embed(texts: string[], inputType: InputType): Promise<number[][]>;
}

export interface ProviderDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** pgvector text literal for a parameter: '[0.1,0.2,...]'::vector */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toPrecision(8) : "0")).join(",")}]`;
}

export function assertDimensions(vectors: number[][], expected: number, provider: string): void {
  for (const v of vectors) {
    if (v.length !== expected) throw new EmbeddingError(`${provider} returned ${v.length} dimensions, expected ${expected}`);
  }
}
