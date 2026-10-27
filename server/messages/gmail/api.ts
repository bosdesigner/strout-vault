// The handful of Gmail API calls the collector makes, all read-only (scope gmail.readonly):
// profile, messages.list, threads.get, history.list. Access tokens come from the account's
// refresh token and live in memory for their lifetime only.
import type { GmailThread } from "./parse.ts";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Google's quota answers: 429, or a 403 whose reason is a rate or per-minute quota limit (not a permission error). */
export function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded|quota exceeded|RESOURCE_EXHAUSTED/i.test(body);
}

export const RATE_LIMIT_RETRIES = 6;

/** Retry-After when Google sends it, else 15 s, 30 s, then 65 s (past the per-minute window). */
export function rateLimitWaitMs(retryAfter: string | null, attempt: number): number {
  const s = Number(retryAfter);
  if (Number.isFinite(s) && s > 0) return Math.min(s, 120) * 1000;
  return Math.min(15_000 * 2 ** attempt, 65_000);
}

export class GmailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GmailClientOptions {
  apiBase: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export class GmailClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  /** API calls made (for the run summary; Gmail costs quota units, not money). */
  calls = 0;

  constructor(private o: GmailClientOptions) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const res = await this.o.fetchImpl(this.o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.o.refreshToken, client_id: this.o.clientId, client_secret: this.o.clientSecret }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; scope?: string };
    if (!res.ok || !body.access_token) throw new GmailApiError(res.status, `token refresh failed: ${body.error ?? res.status}`);
    if (body.scope && body.scope.split(" ").some((s) => s !== GMAIL_READONLY_SCOPE)) throw new GmailApiError(400, `refusing token with scopes beyond gmail.readonly: ${body.scope}`);
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.o.apiBase.replace(/\/$/, "")}/users/me/${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.append(k, String(v));
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const res = await this.o.fetchImpl(url, { headers: { authorization: `Bearer ${await this.token()}` } });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => "");
      // Quota: Gmail answers 429, or 403 "Quota exceeded … per minute per user" / rateLimitExceeded.
      // The per-minute window resets within a minute, so wait it out instead of failing the run.
      if (isRateLimited(res.status, text) && attempt < RATE_LIMIT_RETRIES) {
        await this.o.sleep(rateLimitWaitMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      // Transient server errors: back off a few times, then give up for this run.
      if (res.status >= 500 && attempt < 4) {
        await this.o.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }
      throw new GmailApiError(res.status, `gmail ${path.split("/")[0]} ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.get("profile");
  }

  listMessages(q: string, pageToken?: string): Promise<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
    return this.get("messages", { q, pageToken, maxResults: 500 });
  }

  thread(id: string): Promise<GmailThread> {
    return this.get(`threads/${encodeURIComponent(id)}`, { format: "full" });
  }

  history(startHistoryId: string, pageToken?: string): Promise<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string } }> }>; historyId?: string; nextPageToken?: string }> {
    return this.get("history", { startHistoryId, pageToken, historyTypes: "messageAdded", maxResults: 500 });
  }
}

/** Exchanges an authorization code (connect flow) for tokens. */
export async function exchangeCode(o: { tokenUrl: string; clientId: string; clientSecret: string; redirectUri: string; code: string; fetchImpl: typeof fetch }) {
  const res = await o.fetchImpl(o.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !body.access_token) throw new GmailApiError(res.status, `code exchange failed: ${body.error ?? res.status}`);
  return body;
}
