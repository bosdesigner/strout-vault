// Google's per-minute quota answers (429, and 403 "Quota exceeded … per minute per user") are waited
// out, not treated as failures; a 403 that is a real permission error still fails at once.
import { describe, expect, it } from "vitest";
import { GmailClient, isRateLimited, rateLimitWaitMs } from "../../server/messages/gmail/api.ts";

const QUOTA = JSON.stringify({ error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'", status: "PERMISSION_DENIED" } });
const DENIED = JSON.stringify({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } });

function client(answers: Array<[number, string]>, slept: number[]) {
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), { status: 200 });
    const [status, body] = answers[Math.min(i++, answers.length - 1)];
    return new Response(body, { status });
  }) as typeof fetch;
  return new GmailClient({ apiBase: "http://g.test/gmail/v1", tokenUrl: "http://g.test/token", clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl, sleep: async (ms) => void slept.push(ms) });
}

describe("Google rate limits", () => {
  it("recognises quota answers and not permission errors", () => {
    expect(isRateLimited(403, QUOTA)).toBe(true);
    expect(isRateLimited(429, "")).toBe(true);
    expect(isRateLimited(403, DENIED)).toBe(false);
    expect(rateLimitWaitMs("7", 0)).toBe(7000);
    expect([0, 1, 2, 3].map((a) => rateLimitWaitMs(null, a))).toEqual([15_000, 30_000, 60_000, 65_000]);
  });

  it("waits out a per-minute quota 403 and then succeeds", async () => {
    const slept: number[] = [];
    const c = client([[403, QUOTA], [403, QUOTA], [200, JSON.stringify({ emailAddress: "ben@example.com", historyId: "1" })]], slept);
    expect((await c.profile()).emailAddress).toBe("ben@example.com");
    expect(slept).toEqual([15_000, 30_000]);
  });

  it("fails at once on a real 403", async () => {
    const slept: number[] = [];
    const c = client([[403, DENIED]], slept);
    await expect(c.profile()).rejects.toThrow(/403/);
    expect(slept).toEqual([]);
  });
});
