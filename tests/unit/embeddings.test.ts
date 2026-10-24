import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider, fakeEmbedding } from "../../server/embeddings/fake.ts";
import { VoyageEmbeddingProvider } from "../../server/embeddings/voyage.ts";
import { OpenAIEmbeddingProvider } from "../../server/embeddings/openai.ts";
import { batchTexts, postJsonWithRetry } from "../../server/embeddings/http.ts";
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from "../../server/embeddings/provider.ts";
import { estimateTokens } from "../../server/embeddings/tokens.ts";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("fake embedding provider", () => {
  it("is deterministic, 1024-dimensional and unit length, and makes no network call", async () => {
    const p = new FakeEmbeddingProvider();
    const [a, b] = await p.embed(["The copper gutters on the porch roof", "The copper gutters on the porch roof"], "document");
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    const [q] = await p.embed(["copper gutters porch"], "query");
    const [other] = await p.embed(["seed round valuation term sheet"], "query");
    expect(cosine(a, q)).toBeGreaterThan(cosine(a, other));
    expect(fakeEmbedding("")).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe("vector literal and token estimate", () => {
  it("formats pgvector input and estimates about four characters per token", () => {
    expect(toVectorLiteral([0.5, -0.25, 1])).toBe("[0.50000000,-0.25000000,1.0000000]");
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("one two three")).toBeGreaterThanOrEqual(3);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("batching", () => {
  it("splits by item count and by estimated tokens, keeping order", () => {
    const texts = Array.from({ length: 10 }, (_, i) => `t${i} ${"word ".repeat(50)}`);
    const byCount = batchTexts(texts, estimateTokens, 4, 1e9);
    expect(byCount.map((b) => b.length)).toEqual([4, 4, 2]);
    expect(byCount.flat()).toEqual(texts);
    const byTokens = batchTexts(texts, estimateTokens, 100, estimateTokens(texts[0]) * 3);
    expect(byTokens.every((b) => b.length <= 3)).toBe(true);
    expect(byTokens.flat()).toEqual(texts);
    expect(batchTexts([], estimateTokens, 4, 100)).toEqual([]);
  });
});

function fakeFetch(script: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const step = script.shift() ?? { status: 200, body: {} };
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers });
    return new Response(JSON.stringify(step.body ?? { error: "x" }), { status: step.status, headers: { "content-type": "application/json", ...(step.headers ?? {}) } });
  };
  return { fetchImpl, calls };
}

describe("postJsonWithRetry", () => {
  it("retries 429 and 5xx with backoff (honouring Retry-After) and then succeeds", async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { "retry-after": "2" } }, { status: 503 }, { status: 200, body: { ok: 1 } }]);
    const out = await postJsonWithRetry<{ ok: number }>("https://x.test", { a: 1 }, {}, { fetchImpl: f.fetchImpl, sleep: async (ms) => void waits.push(ms) }, { baseMs: 10, maxMs: 100 });
    expect(out).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(3);
    expect(waits[0]).toBe(2000); // Retry-After wins
    expect(waits[1]).toBeGreaterThan(0);
    expect(waits[1]).toBeLessThanOrEqual(100);
  });

  it("fails at once on a 4xx other than 429 and gives up after maxAttempts", async () => {
    const bad = fakeFetch([{ status: 401, body: { detail: "bad key" } }]);
    await expect(postJsonWithRetry("https://x.test", {}, {}, { fetchImpl: bad.fetchImpl, sleep: async () => {} })).rejects.toThrow(/HTTP 401/);
    expect(bad.calls).toHaveLength(1);
    const down = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    await expect(postJsonWithRetry("https://x.test", {}, {}, { fetchImpl: down.fetchImpl, sleep: async () => {} }, { maxAttempts: 3, baseMs: 1 })).rejects.toThrow(/HTTP 500/);
    expect(down.calls).toHaveLength(3);
  });
});

describe("Voyage provider", () => {
  it("sends the model, input_type and bearer key, batches, and returns vectors in input order", async () => {
    const vec = (seed: number) => Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0));
    const f = fakeFetch([
      { status: 200, body: { data: [{ index: 1, embedding: vec(1) }, { index: 0, embedding: vec(0) }], usage: { total_tokens: 12 } } },
      { status: 200, body: { data: [{ index: 0, embedding: vec(2) }], usage: { total_tokens: 5 } } },
    ]);
    const p = new VoyageEmbeddingProvider({ apiKey: "k", model: "voyage-3.5", url: "https://voyage.test/v1/embeddings" }, { fetchImpl: f.fetchImpl, sleep: async () => {} });
    // 64 per batch: three short texts land in one request unless the token ceiling is hit; force two with a long text.
    const long = "w ".repeat(2 * 100_000);
    const out = await p.embed(["a", "b", long], "document");
    expect(out.map((v) => v.indexOf(1))).toEqual([0, 1, 2]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].headers.authorization).toBe("Bearer k");
    expect(f.calls[0].body).toMatchObject({ model: "voyage-3.5", input_type: "document", input: ["a", "b"] });
    expect(f.calls[0].body).not.toHaveProperty("output_dimension"); // 1024 is voyage-3.5's default
    expect(p.reportedTokens).toBe(17);
    expect(p.usdPerMillionTokens).toBe(0.06);
  });

  it("asks for 1024 dimensions when the model's default differs, and rejects wrong dimensions", async () => {
    const f = fakeFetch([{ status: 200, body: { data: [{ index: 0, embedding: [1, 2, 3] }] } }]);
    const p = new VoyageEmbeddingProvider({ apiKey: "k", model: "voyage-3-lite", url: "https://voyage.test" }, { fetchImpl: f.fetchImpl, sleep: async () => {} });
    await expect(p.embed(["x"], "query")).rejects.toThrow(/3 dimensions, expected 1024/);
    expect(f.calls[0].body).toMatchObject({ output_dimension: 1024, input_type: "query" });
  });
});

describe("OpenAI provider", () => {
  it("sends dimensions=1024 and parses the response", async () => {
    const f = fakeFetch([{ status: 200, body: { data: [{ index: 0, embedding: new Array(1024).fill(0.1) }], usage: { total_tokens: 3 } } }]);
    const p = new OpenAIEmbeddingProvider({ apiKey: "k", model: "text-embedding-3-small", url: "https://openai.test" }, { fetchImpl: f.fetchImpl, sleep: async () => {} });
    const [v] = await p.embed(["x"], "document");
    expect(v).toHaveLength(1024);
    expect(f.calls[0].body).toMatchObject({ model: "text-embedding-3-small", dimensions: 1024, input: ["x"] });
    expect(p.usdPerMillionTokens).toBe(0.02);
  });
});
