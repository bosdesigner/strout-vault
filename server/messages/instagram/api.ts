// The Instagram API calls the vault makes, all read-only toward the inbox: the OAuth code exchange
// (Instagram Login), the long-lived token exchange and refresh, /me, conversations, and message
// details. Nothing here sends, reacts, marks seen or deletes. Reading through the API does not
// mark a message read in the Instagram app (Meta's documented behaviour).
//
// Permissions asked for and accepted: instagram_business_basic + instagram_business_manage_messages.
// Meta's limits worth knowing (developers.facebook.com/documentation/instagram-platform/
// instagram-api-with-instagram-login/conversations-api): details are available for the 20 most
// recent messages of a conversation only, and Requests-folder conversations idle for 30 days are
// not returned. The 10-minute sync keeps up with new messages; history older than that is out of
// reach through the API.

export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"] as const;

export class InstagramApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Graph API error code: 190 is an invalid or expired token, 4/17/32/613 are rate limits. */
    public code: number | null = null,
  ) {
    super(message);
  }
  get tokenInvalid(): boolean {
    return this.code === 190 || this.status === 401;
  }
  get rateLimited(): boolean {
    return this.status === 429 || (this.code !== null && [4, 17, 32, 613].includes(this.code));
  }
}

export interface IgUserRef {
  id: string;
  username?: string;
}

export interface IgMessage {
  id: string;
  created_time: string;
  from?: IgUserRef;
  to?: { data?: IgUserRef[] };
  message?: string;
  attachments?: { data?: Array<{ id?: string; mime_type?: string; name?: string; size?: number; image_data?: { url?: string }; video_data?: { url?: string }; file_url?: string }> };
  shares?: { data?: Array<{ link?: string }> };
  is_unsupported?: boolean;
}

export interface IgConversation {
  id: string;
  updated_time: string | number;
}

interface Page<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const MESSAGE_FIELDS = "id,created_time,from,to,message,attachments,shares,is_unsupported";
const RETRIES = 4;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function apiError(status: number, body: Record<string, unknown>, what: string): InstagramApiError {
  const e = (body.error ?? {}) as { message?: string; code?: number; type?: string };
  // Meta's messages are API text ("Error validating access token: ..."), never message content.
  const msg = `${what}: ${status} ${e.type ? `${e.type} ` : ""}${(e.message ?? String(body.error_message ?? body.raw ?? "")).slice(0, 200)}`;
  return new InstagramApiError(status, msg.trim(), typeof e.code === "number" ? e.code : typeof body.code === "number" ? (body.code as number) : null);
}

/** The short-lived token for a code from the Instagram Login redirect. */
export async function exchangeInstagramCode(o: { tokenUrl: string; appId: string; appSecret: string; redirectUri: string; code: string; fetchImpl: typeof fetch }): Promise<{ accessToken: string; userId: string; permissions: string[] }> {
  const body = new URLSearchParams({ client_id: o.appId, client_secret: o.appSecret, grant_type: "authorization_code", redirect_uri: o.redirectUri, code: o.code.replace(/#_$/, "") });
  const res = await o.fetchImpl(o.tokenUrl, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const j = await readJson(res);
  if (!res.ok) throw apiError(res.status, j, "code exchange");
  // Documented as { data: [{ access_token, user_id, permissions }] }; older apps answer flat.
  const d = (Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>)[0] : j) ?? {};
  const perms = d.permissions;
  return {
    accessToken: String(d.access_token ?? ""),
    userId: String(d.user_id ?? ""),
    permissions: (Array.isArray(perms) ? perms.map(String) : String(perms ?? "").split(",")).map((p) => p.trim()).filter(Boolean),
  };
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
}

export class InstagramClient {
  calls = 0;
  constructor(
    private o: {
      graphBase: string;
      version: string;
      accessToken: string;
      fetchImpl: typeof fetch;
      sleep: (ms: number) => Promise<void>;
      now?: () => Date;
    },
  ) {}

  private url(path: string, params: Record<string, string> = {}, versioned = true): URL {
    const base = this.o.graphBase.replace(/\/$/, "");
    const u = new URL(`${base}${versioned ? `/${this.o.version}` : ""}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  }

  private async get<T>(u: URL, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      // The token goes in the header, never the URL: URLs end up in logs.
      const res = await this.o.fetchImpl(u.toString(), { headers: { authorization: `Bearer ${this.o.accessToken}` } });
      const body = await readJson(res);
      if (res.ok) return body as T;
      const err = apiError(res.status, body, what);
      if ((err.rateLimited || res.status >= 500) && attempt < RETRIES) {
        await this.o.sleep(Math.min(5000 * 2 ** attempt, 60_000));
        continue;
      }
      throw err;
    }
  }

  /** Trades a short-lived token (from the code exchange) for a 60-day one. Server-side only: it carries the app secret. */
  async exchangeLongLived(appSecret: string): Promise<LongLivedToken> {
    const u = this.url("access_token", { grant_type: "ig_exchange_token", client_secret: appSecret }, false);
    const j = await this.get<{ access_token?: string; expires_in?: number }>(u, "long-lived token exchange");
    if (!j.access_token) throw new InstagramApiError(502, "long-lived token exchange returned no token");
    return { accessToken: j.access_token, expiresAt: new Date((this.o.now?.() ?? new Date()).getTime() + (j.expires_in ?? 5_184_000) * 1000) };
  }

  /** A fresh 60 days for a long-lived token at least a day old. */
  async refresh(): Promise<LongLivedToken> {
    const u = this.url("refresh_access_token", { grant_type: "ig_refresh_token" }, false);
    const j = await this.get<{ access_token?: string; expires_in?: number }>(u, "token refresh");
    if (!j.access_token) throw new InstagramApiError(502, "token refresh returned no token");
    return { accessToken: j.access_token, expiresAt: new Date((this.o.now?.() ?? new Date()).getTime() + (j.expires_in ?? 5_184_000) * 1000) };
  }

  async me(): Promise<{ userId: string; id: string; username: string }> {
    const j = await this.get<{ user_id?: string | number; id?: string | number; username?: string }>(this.url("me", { fields: "user_id,username" }), "me");
    return { userId: String(j.user_id ?? j.id ?? ""), id: String(j.id ?? j.user_id ?? ""), username: String(j.username ?? "").toLowerCase() };
  }

  /** One page of conversations, most recently updated first. */
  async conversations(after?: string): Promise<{ items: IgConversation[]; after: string | null }> {
    const params: Record<string, string> = { platform: "instagram", fields: "id,updated_time", limit: "25" };
    if (after) params.after = after;
    const j = await this.get<Page<IgConversation>>(this.url("me/conversations", params), "conversations");
    return { items: j.data ?? [], after: j.paging?.next ? (j.paging.cursors?.after ?? null) : null };
  }

  /**
   * The newest messages of a conversation with their details (at most 20 are readable). Asks for
   * the fields inline; when the API returns ids only, reads each message on its own.
   */
  async messages(conversationId: string): Promise<IgMessage[]> {
    const j = await this.get<{ messages?: Page<IgMessage> }>(this.url(conversationId, { fields: `messages.limit(20){${MESSAGE_FIELDS}}` }), "conversation messages");
    const list = (j.messages?.data ?? []).slice(0, 20);
    const out: IgMessage[] = [];
    for (const m of list) {
      if (m.from || m.message !== undefined || m.attachments || m.shares) {
        out.push(m);
        continue;
      }
      try {
        out.push(await this.get<IgMessage>(this.url(m.id, { fields: MESSAGE_FIELDS }), "message"));
      } catch (err) {
        // Older than the newest 20: Meta answers as if the message were deleted. Nothing to read.
        if (err instanceof InstagramApiError && !err.tokenInvalid && !err.rateLimited) continue;
        throw err;
      }
    }
    return out;
  }
}
