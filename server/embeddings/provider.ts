// Embedding providers behind one small interface. Swapping providers is a config change
// (EMBEDDING_PROVIDER); the column stays vector(1024), so every provider must produce
// exactly 1024 dimensions.
import type { Config } from "../config.ts";
import { EmbeddingError, type EmbeddingProvider, type ProviderDeps } from "./types.ts";
import { VoyageEmbeddingProvider } from "./voyage.ts";
import { OpenAIEmbeddingProvider } from "./openai.ts";
import { FakeEmbeddingProvider } from "./fake.ts";

export * from "./types.ts";

/** Null when EMBEDDING_PROVIDER=off; throws when the chosen provider has no key. */
export function createEmbeddingProvider(config: Config, deps: ProviderDeps): EmbeddingProvider | null {
  switch (config.EMBEDDING_PROVIDER) {
    case "off":
      return null;
    case "fake":
      return new FakeEmbeddingProvider(config.EMBEDDING_MODEL ?? "fake-hash-1024");
    case "voyage":
      if (!config.VOYAGE_API_KEY) throw new EmbeddingError("EMBEDDING_PROVIDER=voyage needs VOYAGE_API_KEY");
      return new VoyageEmbeddingProvider({ apiKey: config.VOYAGE_API_KEY, model: config.EMBEDDING_MODEL ?? "voyage-3.5", url: config.VOYAGE_API_URL }, deps);
    case "openai":
      if (!config.OPENAI_API_KEY) throw new EmbeddingError("EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY");
      return new OpenAIEmbeddingProvider({ apiKey: config.OPENAI_API_KEY, model: config.EMBEDDING_MODEL ?? "text-embedding-3-small", url: config.OPENAI_API_URL }, deps);
  }
}
