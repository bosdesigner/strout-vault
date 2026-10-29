// Zoom Server-to-Server OAuth client and cloud-recording enumeration.
// Ported from meeting-vault's zoom.py. Read-only on purpose: the only verbs
// used are GET (and the POST that mints a token). Nothing here can delete
// anything from Zoom.
//
// Two Zoom quirks shape the code: the recordings endpoint accepts at most a
// one-month span, so history is walked month by month; and results paginate
// with next_page_token inside each window.

import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";

export const USER_AGENT = "strout-vault/0.4 (+private archive worker)";

/** Zoom file_type -> media.kind. TIMELINE/CSV/SUMMARY are regenerable metadata and are not archived. */
export const FILE_KIND: Record<string, string> = {
  MP4: "video",
  M4A: "audio",
  TRANSCRIPT: "transcript_vtt",
  CC: "caption_vtt",
  CHAT: "chat",
  TIMELINE: "timeline",
  CSV: "poll_csv",
  SUMMARY: "summary",
};
export const CORE_KINDS = ["video", "audio", "transcript_vtt", "caption_vtt"] as const;
export const ARCHIVE_KINDS = [...CORE_KINDS, "chat"] as const;

export interface RecordingFile {
  fileId: string;
  kind: string;
  fileType: string;
  extension: string;
  size: number;
  downloadUrl: string;
  recordingStart: string | null;
  recordingEnd: string | null;
  recordingType: string | null;
  status: string;
}

export interface Recording {
  uuid: string;
  meetingNumber: string;
  topic: string;
  startTime: string;
  durationMin: number;
  totalSize: number;
  hostEmail: string;
  files: RecordingFile[];
  raw: Record<string, unknown>;
}

export class ZoomError extends Error {
  constructor(
    message: string,
    /** The HTTP status Zoom answered with, when it answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}
export class ZoomAuthError extends ZoomError {}

export interface ZoomClientOptions {
  accountId: string;
  clientId: string;
  clientSecret: string;
  apiBase?: string;
  oauthBase?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ZoomClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly apiBase: string;
  readonly oauthBase: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly opts: ZoomClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.apiBase = (opts.apiBase ?? "https://api.zoom.us/v2").replace(/\/$/, "");
    this.oauthBase = (opts.oauthBase ?? "https://zoom.us").replace(/\/$/, "");
  }

  /** account_credentials token, cached until ~60 s before expiry. */
  async token(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const params = new URLSearchParams({ grant_type: "account_credentials", account_id: this.opts.accountId });
    const res = await this.fetchImpl(`${this.oauthBase}/oauth/token?${params}`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "user-agent": USER_AGENT },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new ZoomAuthError(
        `Zoom token request failed (${res.status}). ${scrub(body)} Check that the app is a Server-to-Server OAuth app, is activated, and has the recording:read:admin and user:read:admin scopes.`,
      );
    }
    const payload = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new ZoomAuthError("Zoom returned no access_token");
    this.accessToken = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  /** GET an API path with backoff on 429/5xx and one retry on 401. */
  async request<T = Record<string, unknown>>(path: string, params: Record<string, string | number | undefined> = {}, retries = 5): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${this.apiBase}${path}${qs.size ? `?${qs}` : ""}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { authorization: `Bearer ${await this.token()}`, "user-agent": USER_AGENT, accept: "application/json" },
        });
      } catch (err) {
        if (attempt <= retries) {
          await this.sleep(Math.min(30_000, 2 ** attempt * 1000));
          continue;
        }
        throw new ZoomError(`network error on ${path}: ${(err as Error).message}`);
      }
      if (res.ok) return (await res.json()) as T;
      const body = (await res.text()).slice(0, 400);
      if (res.status === 401 && attempt === 1) {
        await this.token(true);
        continue;
      }
      if (res.status === 429) {
        if (attempt > retries) throw new ZoomError(`rate limited after ${retries} retries: ${scrub(body)}`);
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep((Number.isFinite(ra) && ra > 0 ? ra : Math.min(60, 2 ** attempt)) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt <= retries) {
        await this.sleep(Math.min(60_000, 2 ** attempt * 1000));
        continue;
      }
      throw new ZoomError(`Zoom API ${res.status} on ${path}: ${scrub(body)}`, res.status);
    }
  }

  /** Follow next_page_token until exhausted. */
  async *paged<T>(path: string, params: Record<string, string | number | undefined>, key: string): AsyncGenerator<T> {
    const p = { page_size: 300, ...params };
    let token = "";
    const seen = new Set<string>();
    for (;;) {
      const payload = await this.request<Record<string, unknown>>(path, token ? { ...p, next_page_token: token } : p);
      for (const item of (payload[key] as T[] | undefined) ?? []) yield item;
      token = String(payload.next_page_token ?? "");
      if (!token || seen.has(token)) break;
      seen.add(token);
    }
  }

  async me(): Promise<Record<string, unknown>> {
    return this.request("/users/me");
  }

  /** Every user whose recordings to sweep. A non-admin token falls back to `me`. */
  async listUsers(): Promise<Array<{ id: string; email?: string; created_at?: string }>> {
    const users: Array<{ id: string; email?: string; created_at?: string }> = [];
    const seen = new Set<string>();
    for (const status of ["active", "inactive"]) {
      try {
        for await (const u of this.paged<{ id: string; email?: string; created_at?: string }>("/users", { status }, "users")) {
          if (u.id && !seen.has(u.id)) {
            seen.add(u.id);
            users.push(u);
          }
        }
      } catch (err) {
        if (err instanceof ZoomAuthError) throw err;
        break;
      }
    }
    if (!users.length) {
      try {
        const me = (await this.me()) as { id?: string; email?: string };
        users.push({ id: me.id ?? "me", email: me.email });
      } catch {
        users.push({ id: "me" });
      }
    }
    return users;
  }

  /**
   * Who joined a past meeting, by meeting UUID (name, and email when the participant was signed
   * in). Needs meeting:read:admin (or meeting:read:past_meeting:admin on granular apps); the
   * recording-only app gets 400/403/404, which callers treat as "not available". UUIDs that start
   * with "/" or contain "//" are double-encoded, as Zoom requires.
   */
  async pastMeetingParticipants(uuid: string): Promise<Array<{ name: string | null; email: string | null }>> {
    const enc = uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid);
    const out: Array<{ name: string | null; email: string | null }> = [];
    for await (const p of this.paged<{ name?: string; user_email?: string }>(`/past_meetings/${enc}/participants`, { page_size: 300 }, "participants")) {
      out.push({ name: p.name?.trim() || null, email: p.user_email?.trim().toLowerCase() || null });
    }
    return out;
  }

  async *listRecordings(userId: string, from: string, to: string): AsyncGenerator<Recording> {
    for await (const item of this.paged<Record<string, unknown>>(
      `/users/${encodeURIComponent(userId)}/recordings`,
      { from, to, page_size: 300, mc: "false", trash: "false" },
      "meetings",
    )) {
      yield parseRecording(item);
    }
  }

  /**
   * Every recording in [startMonth, endMonth], oldest window first, de-duplicated by
   * UUID (a meeting surfaces under more than one user when hosts change).
   */
  async *iterWindows(startMonth: string, endMonth?: string, onWindow?: (from: string, to: string, found: number) => void): AsyncGenerator<Recording> {
    const users = await this.listUsers();
    const seen = new Set<string>();
    for (const [from, to] of monthWindows(startMonth, endMonth, this.opts.now?.() ?? new Date())) {
      let found = 0;
      for (const u of users) {
        for await (const rec of this.listRecordings(u.id || "me", from, to)) {
          if (!rec.uuid || seen.has(rec.uuid)) continue;
          seen.add(rec.uuid);
          found++;
          yield rec;
        }
      }
      onWindow?.(from, to, found);
    }
  }

  /**
   * Open a recording file as a byte stream. Zoom's download_url 302s to a CDN;
   * redirects are followed by hand so the bearer token never travels to a
   * third-party host. Some endpoints want `?access_token=` instead of the
   * header, which is tried once on 401/403.
   */
  async openDownload(downloadUrl: string, retries = 4): Promise<{ stream: Readable; contentLength: number | null; finalUrl: string }> {
    let useQueryToken = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.token();
      let url = downloadUrl;
      const headers: Record<string, string> = { "user-agent": USER_AGENT };
      if (useQueryToken) {
        url += (url.includes("?") ? "&" : "?") + `access_token=${encodeURIComponent(token)}`;
      } else {
        headers.authorization = `Bearer ${token}`;
      }
      let res: Response;
      try {
        res = await this.followRedirects(url, headers);
      } catch (err) {
        if (attempt <= retries) {
          await this.sleep(Math.min(30_000, 2 ** attempt * 1000));
          continue;
        }
        throw new ZoomError(`network error downloading: ${(err as Error).message}`);
      }
      if (res.ok && res.body) {
        const len = Number(res.headers.get("content-length"));
        return {
          stream: NodeReadable.fromWeb(res.body as import("node:stream/web").ReadableStream),
          contentLength: Number.isFinite(len) && len > 0 ? len : null,
          finalUrl: res.url || url,
        };
      }
      const body = res.body ? (await res.text()).slice(0, 300) : "";
      if ((res.status === 401 || res.status === 403) && !useQueryToken) {
        useQueryToken = true;
        continue;
      }
      if (res.status === 429 && attempt <= retries) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep((Number.isFinite(ra) && ra > 0 ? ra : Math.min(30, 2 ** attempt)) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt <= retries) {
        await this.sleep(Math.min(30_000, 2 ** attempt * 1000));
        continue;
      }
      throw new ZoomError(`HTTP ${res.status} downloading ${stripToken(downloadUrl)}: ${scrub(body)}`);
    }
  }

  private async followRedirects(url: string, headers: Record<string, string>): Promise<Response> {
    let current = url;
    let h = { ...headers };
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.fetchImpl(current, { headers: h, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, current).toString();
        if (new URL(next).host !== new URL(current).host) {
          // Leaving Zoom: the bearer token must not follow.
          const { authorization: _drop, ...rest } = h;
          h = rest;
        }
        current = next;
        continue;
      }
      return res;
    }
    throw new ZoomError("too many redirects");
  }
}

export function parseRecording(item: Record<string, unknown>): Recording {
  const files: RecordingFile[] = [];
  for (const raw of (item.recording_files as Array<Record<string, unknown>> | undefined) ?? []) {
    const fileType = String(raw.file_type ?? "").toUpperCase();
    files.push({
      fileId: String(raw.id ?? `${fileType}-${raw.recording_start ?? ""}`),
      kind: FILE_KIND[fileType] ?? "other",
      fileType,
      extension: String(raw.file_extension ?? fileType ?? "bin").toLowerCase(),
      size: Number(raw.file_size ?? 0) || 0,
      downloadUrl: String(raw.download_url ?? ""),
      recordingStart: (raw.recording_start as string | undefined) ?? null,
      recordingEnd: (raw.recording_end as string | undefined) ?? null,
      recordingType: (raw.recording_type as string | undefined) ?? null,
      status: String(raw.status ?? "completed"),
    });
  }
  return {
    uuid: String(item.uuid ?? ""),
    meetingNumber: String(item.id ?? ""),
    topic: String(item.topic ?? "") || "(no topic)",
    startTime: String(item.start_time ?? ""),
    durationMin: Number(item.duration ?? 0) || 0,
    totalSize: Number(item.total_size ?? 0) || 0,
    hostEmail: String(item.host_email ?? ""),
    files,
    raw: item,
  };
}

/**
 * Inclusive (from, to) date pairs covering each calendar month from `start`
 * (YYYY-MM) to `end` (YYYY-MM, default: the current month), never past today.
 */
export function monthWindows(start: string, end?: string, today: Date = new Date()): Array<[string, string]> {
  const t = toUtcDate(today);
  const startDate = parseMonth(start);
  const endDate = end ? parseMonth(end) : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const out: Array<[string, string]> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const trueEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const lastDay = trueEnd < t ? trueEnd : t;
    if (lastDay < cursor) break; // whole window in the future
    out.push([iso(cursor), iso(lastDay)]);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return out;
}

/** YYYY-MM of the month `n` months before the given month. */
export function monthsBefore(month: string, n: number): string {
  const d = parseMonth(month);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(s: string): Date {
  const m = /^(\d{4})-(\d{2})/.exec(s.trim());
  if (!m) throw new Error(`bad month ${JSON.stringify(s)} (want YYYY-MM)`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

function toUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Remove any access_token before a URL is persisted or logged. */
export function stripToken(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("access_token")) return url;
    u.searchParams.delete("access_token");
    return u.toString();
  } catch {
    return url;
  }
}

/** Error text without tokens. */
export function scrub(text: string): string {
  return text.replace(/access_token=[^&\s"']+/gi, "access_token=…").replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer …");
}
