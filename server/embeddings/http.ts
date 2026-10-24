// One JSON POST with retries: 429 and 5xx (and network errors) back off exponentially with
// jitter and honour Retry-After; 4xx other than 429 fail at once. Used by both HTTP providers.
import { EmbeddingError } from "./types.ts";

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
}

export async function postJsonWithRetry<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  deps: { fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>; log?: (line: string) => void },
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 20_000;
  let lastError: EmbeddingError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (err) {
      lastError = new EmbeddingError(`network error: ${(err as Error).message}`);
      if (attempt === maxAttempts) break;
      await deps.sleep(backoff(attempt, baseMs, maxMs));
      continue;
    }
    if (res.ok) {
      return (await res.json()) as T;
    }
    const text = (await res.text().catch(() => "")).slice(0, 300);
    lastError = new EmbeddingError(`HTTP ${res.status}${text ? `: ${text}` : ""}`, res.status);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : backoff(attempt, baseMs, maxMs);
    deps.log?.(`embeddings: ${res.status} from provider, retrying in ${Math.round(wait)} ms (attempt ${attempt}/${maxAttempts})`);
    await deps.sleep(wait);
  }
  throw lastError ?? new EmbeddingError("embedding request failed");
}

function backoff(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return exp * (0.5 + Math.random() * 0.5);
}

/** Splits texts into batches under both a count and an estimated-token ceiling, keeping order. */
export function batchTexts(texts: string[], estimate: (t: string) => number, maxItems: number, maxTokens: number): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const t of texts) {
    const n = estimate(t);
    if (cur.length && (cur.length >= maxItems || curTokens + n > maxTokens)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(t);
    curTokens += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
