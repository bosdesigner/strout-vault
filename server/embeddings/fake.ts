// Deterministic offline embeddings for development and CI: a hashed bag of words (unigrams
// and bigrams) projected into 1024 dimensions and L2-normalised. Texts that share words land
// close together; true paraphrases do not, which is why the semantic quality check needs a
// real provider. Never makes a network call.
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, type InputType } from "./types.ts";

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly usdPerMillionTokens = 0;
  constructor(readonly model = "fake-hash-1024") {}

  async embed(texts: string[], _inputType: InputType): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, this.dimensions));
  }
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "it", "we", "i", "you", "that", "this", "for", "with", "be", "are", "was", "so", "as", "if"]);

export function fakeEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // speaker labels carry no meaning
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  const bump = (term: string, weight: number) => {
    const h = fnv1a(term);
    const idx = h % dims;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    v[idx] += sign * weight;
  };
  for (let i = 0; i < words.length; i++) {
    bump(words[i], 1);
    if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`, 0.5);
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    norm = 1;
  }
  return v.map((x) => x / norm);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
