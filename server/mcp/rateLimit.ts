/**
 * Per-token sliding window: at most `limit` calls in any `windowMs`. In memory, per
 * process: on an autoscaled deployment each instance counts separately, which only ever
 * lets a token through more often, never less.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((arr[0] + this.windowMs - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.prune(t);
    return { allowed: true, remaining: this.limit - arr.length, retryAfterSec: 0 };
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
  }
}
