// The Google calls the Meet step makes, all read-only: Drive files.list / files.get (download) /
// files.export (a transcript Doc as plain text) under drive.meet.readonly, and Calendar
// events.list under calendar.events.readonly when that was granted too. A Meet account's refresh
// token is its own grant, separate from the Gmail one, so Gmail's stays gmail.readonly only.
import { Readable } from "node:stream";
import { isRateLimited, Pacer, RATE_LIMIT_RETRIES, rateLimitWaitMs } from "../messages/gmail/api.ts";

export const DRIVE_MEET_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.meet.readonly";
export const CALENDAR_EVENTS_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
/** Identity only (who the account is), asked for with ?identify=1 when Drive's about.get will not say. No data access. */
export const IDENTITY_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/userinfo.email"];
/** Everything a Meet grant may contain. The callback and every token refresh refuse anything else. */
export const MEET_ALLOWED_SCOPES = [DRIVE_MEET_READONLY_SCOPE, CALENDAR_EVENTS_READONLY_SCOPE, ...IDENTITY_SCOPES];
export const MEET_TRANSCRIPT_MIME = "application/vnd.google-apps.document";

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  driveId?: string;
  videoMediaMetadata?: { durationMillis?: string };
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  hangoutLink?: string;
  location?: string;
  description?: string;
  conferenceData?: { conferenceSolution?: { key?: { type?: string } }; conferenceId?: string; entryPoints?: Array<{ uri?: string }> };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; resource?: boolean }>;
}

export interface MeetClientOptions {
  driveBase: string;
  calendarBase: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

/** Refuses a grant that holds anything beyond drive.meet.readonly (+ calendar.events.readonly). */
export function checkMeetScopes(granted: string[]): string | null {
  if (!granted.includes(DRIVE_MEET_READONLY_SCOPE)) return `the grant does not include drive.meet.readonly (${granted.join(" ") || "nothing"})`;
  const extra = granted.filter((s) => !MEET_ALLOWED_SCOPES.includes(s));
  return extra.length ? `the grant includes more than drive.meet.readonly, calendar.events.readonly and sign-in identity (${extra.join(" ")})` : null;
}

export class MeetClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  /** What the last token refresh said was granted. */
  scopes: string[] = [];
  calls = 0;
  private pacer: Pacer;

  constructor(private o: MeetClientOptions) {
    this.pacer = new Pacer(o.sleep);
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const res = await this.o.fetchImpl(this.o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.o.refreshToken, client_id: this.o.clientId, client_secret: this.o.clientSecret }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; scope?: string };
    if (!res.ok || !body.access_token) throw new GoogleApiError(res.status, `token refresh failed: ${body.error ?? res.status}`);
    if (body.scope) {
      this.scopes = body.scope.split(" ").filter(Boolean);
      const bad = checkMeetScopes(this.scopes);
      if (bad) throw new GoogleApiError(400, `refusing token: ${bad}`);
    }
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request(url: URL): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.pacer.wait();
      this.calls++;
      const res = await this.o.fetchImpl(url, { headers: { authorization: `Bearer ${await this.token()}` } });
      if (res.ok) {
        this.pacer.ok();
        return res;
      }
      const text = await res.text().catch(() => "");
      if (isRateLimited(res.status, text) && attempt < RATE_LIMIT_RETRIES) {
        this.pacer.slowDown();
        await this.o.sleep(rateLimitWaitMs(res.headers.get("retry-after"), attempt));
        continue;
      }
      if (res.status >= 500 && attempt < 4) {
        await this.o.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }
      throw new GoogleApiError(res.status, `${url.hostname}${url.pathname.replace(/\/files\/[^/]+/, "/files/…")} ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private url(base: string, path: string, query: Record<string, string | number | undefined>): URL {
    const url = new URL(`${base.replace(/\/$/, "")}/${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.append(k, String(v));
    return url;
  }

  /** One page of Drive files matching `q`, newest first, including shared drives when asked. */
  async listFiles(q: string, pageToken?: string, sharedDrives = true): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const res = await this.request(
      this.url(this.o.driveBase, "files", {
        q,
        pageToken,
        pageSize: 100,
        orderBy: "createdTime desc",
        fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents,driveId,videoMediaMetadata(durationMillis))",
        ...(sharedDrives ? { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" } : {}),
      }),
    );
    return (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
  }

  /** The file's bytes as a stream (alt=media). */
  async download(fileId: string): Promise<{ stream: NodeJS.ReadableStream; contentLength: number | null }> {
    const res = await this.request(this.url(this.o.driveBase, `files/${encodeURIComponent(fileId)}`, { alt: "media", supportsAllDrives: "true" }));
    if (!res.body) throw new GoogleApiError(502, "download returned no body");
    const len = Number(res.headers.get("content-length") ?? "");
    return { stream: Readable.fromWeb(res.body as never), contentLength: Number.isFinite(len) && len > 0 ? len : null };
  }

  /** A Google Doc as plain text (the Meet transcript). */
  async exportText(fileId: string): Promise<string> {
    const res = await this.request(this.url(this.o.driveBase, `files/${encodeURIComponent(fileId)}/export`, { mimeType: "text/plain" }));
    return res.text();
  }

  /** Calendar events overlapping [from, to] on the primary calendar (only with calendar.events.readonly). */
  async events(from: Date, to: Date): Promise<CalendarEvent[]> {
    const res = await this.request(
      this.url(this.o.calendarBase, "calendars/primary/events", { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", maxResults: 50 }),
    );
    return ((await res.json()) as { items?: CalendarEvent[] }).items ?? [];
  }
}
