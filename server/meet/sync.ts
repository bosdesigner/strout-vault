// Google Meet into the vault, read-only (drive.meet.readonly; calendar.events.readonly when it was
// granted). Meet saves a recording (an MP4) and, when transcription was on, a transcript Google Doc
// to the organizer's Drive ("Meet Recordings"). Per connected Meet account (message_accounts,
// provider 'meet'), two passes, the same shape as the Zoom step:
//
//   1. enumerate  Drive files.list for MP4s created since the account's cursor (detail.cursor),
//                 and the transcript Docs beside them. Each new recording becomes an interaction
//                 (kind 'meeting', source 'meet', source_ref 'meet:<account>:<driveFileId>') plus
//                 a pending media row; a transcript Doc is exported as text, stored next to it and
//                 recorded as media kind 'transcript_meet', which the transcribe step reads the way
//                 it reads Zoom's TRANSCRIPT file (Groq only when there is none). Participants come
//                 from the transcript's speakers and attendees and, when Calendar was granted, the
//                 matching event's guests; existing party matching only, never a new party.
//                 Routing is the messages routing; phalanx is never assigned automatically.
//   2. download   every pending Meet file streamed from Drive into the archive bucket while hashing,
//                 its size checked against Drive's (Zoom's download/verify logic). Resumable: the
//                 run's time and byte budgets leave the rest for the next hour.
//
// An account that has never had a Meet recording (a plan without recording) is marked
// capability 'none_found' once and checked again cheaply on later runs; a Drive error is recorded on
// the account and the step moves to the next account. Nothing here deletes, moves or edits a file.
import { Readable } from "node:stream";
import type pg from "pg";
import type { WorkerContext } from "../worker/context.ts";
import { outOfTime } from "../worker/context.ts";
import { decryptSecret } from "../messages/crypto.ts";
import { gmailConfigured } from "../messages/gmail/sync.ts";
import { ownerIdentity, normalizeEmail, isOwner } from "../messages/identity.ts";
import { INBOX, matchParties, routeThread, type PartyRef } from "../messages/ingest.ts";
import { loadMessageRules, type MessageRules } from "../messages/rules.ts";
import { matchNames, noAutoPhalanx } from "../device/ingest.ts";
import { CALENDAR_EVENTS_READONLY_SCOPE, GoogleApiError, MeetClient, MEET_TRANSCRIPT_MIME, type DriveFile } from "./api.ts";
import { meetBaseName, parseMeetTranscript } from "./transcript.ts";
import { newVaultId } from "../worker/sync.ts";

export interface MeetAccountResult {
  account: string;
  recordingsSeen: number;
  recordingsNew: number;
  transcripts: number;
  capability: string | null;
  error?: string;
}

export interface MeetSyncSummary {
  configured: boolean;
  dryRun: boolean;
  accounts: MeetAccountResult[];
  filesVerified: number;
  filesFailed: number;
  bytes: number;
  /** Dry run: bytes the new recordings would download. */
  bytesPending: number;
  stoppedEarly?: string;
  skipped?: string;
  errors: string[];
}

export interface MeetSyncOptions {
  dryRun?: boolean;
  /** Only this account (backfill command). */
  account?: string;
  /** Look back this many days instead of from the cursor (backfill). */
  sinceDays?: number;
  /** Tests inject rules instead of reading config/*.yml. */
  rules?: MessageRules;
}

/**
 * How far back the first listing of an account reaches. It used to be 14 days, and because the
 * cursor only moved when a recording turned up, an account with no recent Meet recording was listed
 * over a rolling 14-day window forever and never backfilled (docs/phase1-map.md section 5).
 */
const FIRST_RUN_DAYS = 365;
const MAX_DOWNLOAD_ATTEMPTS = 4;

interface MeetAccount {
  id: number;
  email: string;
  refreshTokenEnc: string;
  scope: string;
  capability: string | null;
  detail: Record<string, unknown>;
}

export async function listMeetAccounts(pool: pg.Pool, email?: string): Promise<MeetAccount[]> {
  const params: unknown[] = [];
  let where = `provider = 'meet' and status <> 'disabled'`;
  if (email) {
    params.push(email.toLowerCase());
    where += ` and account_email = $1`;
  }
  const { rows } = await pool.query(`select * from message_accounts where ${where} order by id`, params);
  return rows.map((r) => ({ id: Number(r.id), email: r.account_email, refreshTokenEnc: r.refresh_token_enc, scope: r.scope ?? "", capability: r.capability ?? null, detail: r.detail ?? {} }));
}

export function meetClientFor(ctx: WorkerContext, account: Pick<MeetAccount, "refreshTokenEnc">): MeetClient {
  const c = ctx.config;
  return new MeetClient({
    driveBase: c.DRIVE_API_BASE,
    calendarBase: c.CALENDAR_API_BASE,
    tokenUrl: c.GOOGLE_OAUTH_TOKEN_URL,
    clientId: c.GOOGLE_CLIENT_ID!,
    clientSecret: c.GOOGLE_CLIENT_SECRET!,
    refreshToken: decryptSecret(account.refreshTokenEnc, c.MESSAGES_ENCRYPTION_KEY),
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
  });
}

export async function syncMeet(ctx: WorkerContext, opts: MeetSyncOptions = {}): Promise<MeetSyncSummary> {
  const summary: MeetSyncSummary = { configured: gmailConfigured(ctx.config), dryRun: !!opts.dryRun, accounts: [], filesVerified: 0, filesFailed: 0, bytes: 0, bytesPending: 0, errors: [] };
  if (!summary.configured) {
    summary.skipped = "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / MESSAGES_ENCRYPTION_KEY not set";
    return summary;
  }
  const accounts = await listMeetAccounts(ctx.pool, opts.account);
  if (!accounts.length) {
    summary.skipped = opts.account ? `no Meet account ${opts.account}` : "no Meet account connected";
    return summary;
  }
  const rules = opts.rules ?? loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR);
  const clients = new Map<number, MeetClient>();
  for (const account of accounts) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const result: MeetAccountResult = { account: account.email, recordingsSeen: 0, recordingsNew: 0, transcripts: 0, capability: account.capability };
    summary.accounts.push(result);
    try {
      const client = meetClientFor(ctx, account);
      clients.set(account.id, client);
      await enumerateAccount(ctx, client, account, opts, rules, result, summary);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      result.error = msg;
      summary.errors.push(`${account.email}: ${msg}`);
      ctx.log(`meet: ${account.email}: ${msg}`);
      if (!opts.dryRun) {
        // A revoked grant needs a reconnect; anything else is retried on the next run (once per run, not in a loop).
        const revoked = err instanceof GoogleApiError && (err.status === 400 || err.status === 401) && /invalid_grant|refusing token/.test(msg);
        await ctx.pool.query(`update message_accounts set last_error = $2, status = case when $3 then 'error' else status end, updated_at = now() where id = $1`, [account.id, msg, revoked]);
      }
    }
  }
  if (opts.dryRun) return summary;
  await downloadPending(ctx, accounts, clients, summary);
  return summary;
}

async function enumerateAccount(ctx: WorkerContext, client: MeetClient, account: MeetAccount, opts: MeetSyncOptions, rules: MessageRules, result: MeetAccountResult, summary: MeetSyncSummary) {
  const cursor = typeof account.detail.cursor === "string" ? new Date(account.detail.cursor) : null;
  const since = opts.sinceDays ? new Date(ctx.now().getTime() - opts.sinceDays * 86400_000) : cursor ?? new Date(ctx.now().getTime() - FIRST_RUN_DAYS * 86400_000);
  const shared = ctx.config.MEET_SHARED_DRIVES === "1";
  const recordings = await listAll(client, `mimeType='video/mp4' and trashed=false and createdTime > '${since.toISOString()}'`, shared);
  // Transcripts can be written a little after the recording; look a day further back for them.
  const docs = await listAll(client, `mimeType='${MEET_TRANSCRIPT_MIME}' and trashed=false and createdTime > '${new Date(since.getTime() - 86400_000).toISOString()}'`, shared);
  const transcripts = new Map<string, DriveFile>();
  for (const d of docs) if (/transcript/i.test(d.name)) transcripts.set(meetBaseName(d.name), d);
  result.recordingsSeen = recordings.length;
  // Never had a recording: say so once on the account and move on; checked again (one call) next run.
  const everHad = account.capability === "recordings" || recordings.length > 0 || Number(account.detail.recordings_seen ?? 0) > 0;
  result.capability = everHad ? "recordings" : "none_found";
  // Why none: are Meet meetings happening at all? Calendar events with a Meet link in the last 30
  // days, and Meet-made Docs (transcripts, Gemini notes) Drive shows this grant. Meetings but no
  // files means recording/transcripts are not being saved for this account (a Workspace setting).
  let diagnosis: Record<string, unknown> | null = null;
  const calendarGranted = client.scopes.includes(CALENDAR_EVENTS_READONLY_SCOPE) || account.scope.split(" ").includes(CALENDAR_EVENTS_READONLY_SCOPE);
  if (!everHad && calendarGranted) {
    try {
      const evs = await client.events(new Date(ctx.now().getTime() - 30 * 86400_000), ctx.now());
      const meetEvents = evs.filter((e) => e.hangoutLink || e.conferenceData?.conferenceSolution?.key?.type === "hangoutsMeet").length;
      diagnosis = {
        meet_events_30d: meetEvents,
        meet_docs_seen: docs.length,
        checked_since: since.toISOString().slice(0, 10),
        verdict: meetEvents > 0 ? "meetings_but_no_recordings_saved" : "no_meet_meetings",
      };
    } catch (err) {
      diagnosis = { error: (err as Error).message.slice(0, 200) };
    }
  }

  const calendar = client.scopes.includes(CALENDAR_EVENTS_READONLY_SCOPE) || account.scope.split(" ").includes(CALENDAR_EVENTS_READONLY_SCOPE);
  const owner = ownerIdentity(ctx.config, [account.email]);
  let newest = cursor;
  for (const rec of recordings) {
    const created = rec.createdTime ? new Date(rec.createdTime) : null;
    if (created && (!newest || created > newest)) newest = created;
    const ref = `meet:${account.email}:${rec.id}`;
    const exists = await ctx.pool.query(`select 1 from interactions where source = 'meet' and source_ref = $1`, [ref]);
    if (exists.rowCount) continue;
    result.recordingsNew++;
    const doc = transcripts.get(meetBaseName(rec.name)) ?? null;
    if (doc) result.transcripts++;
    if (opts.dryRun) {
      summary.bytesPending += Number(rec.size ?? 0);
      continue;
    }
    await recordMeeting(ctx, client, account, rec, doc, { calendar, owner, rules });
  }
  if (!opts.dryRun) {
    // The cursor moves even when nothing was found, so the next run lists only what is new.
    const cursorNext = newest ?? (!opts.sinceDays ? new Date(Math.max(since.getTime(), ctx.now().getTime() - 86400_000)) : null);
    const detail = {
      ...account.detail,
      ...(cursorNext && !opts.sinceDays ? { cursor: cursorNext.toISOString() } : {}),
      ...(diagnosis ? { diagnosis } : {}),
      last_listed_at: ctx.now().toISOString(),
      recordings_seen: Number(account.detail.recordings_seen ?? 0) + result.recordingsNew,
      calendar,
    };
    await ctx.pool.query(`update message_accounts set capability = $2, detail = $3::jsonb, last_synced_at = now(), last_error = null, status = 'active', updated_at = now() where id = $1`, [account.id, result.capability, JSON.stringify(detail)]);
  }
  ctx.log(`meet: ${account.email}: ${recordings.length} recording(s) since ${since.toISOString().slice(0, 10)}, ${result.recordingsNew} new, ${result.transcripts} with a transcript${result.capability === "none_found" ? " (no Meet recordings on this account)" : ""}${opts.dryRun ? " (dry run)" : ""}`);
}

async function listAll(client: MeetClient, q: string, shared: boolean): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let page: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await client.listFiles(q, page, shared);
    out.push(...(r.files ?? []));
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return out;
}

/** meet/<yyyy>/<yyyy-mm-dd>_m<file id slug>/original/<name> in the archive bucket. */
export function meetObjectKey(rec: DriveFile, name: string): string {
  const start = rec.createdTime ? new Date(rec.createdTime) : null;
  const ok = start && !Number.isNaN(start.getTime());
  const slug = rec.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "x";
  return `meet/${ok ? start.getUTCFullYear() : "unknown"}/${ok ? start.toISOString().slice(0, 10) : "unknown-date"}_m${slug}/original/${name}`;
}

/** "Weekly sync (2026-10-20 14:03 GMT-5)" -> "Weekly sync". */
function meetTitle(name: string): string {
  return name.replace(/\.(mp4)$/i, "").replace(/\s*[-–]\s*recording\s*$/i, "").replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, "").trim() || "Google Meet";
}

async function recordMeeting(
  ctx: WorkerContext,
  client: MeetClient,
  account: MeetAccount,
  rec: DriveFile,
  doc: DriveFile | null,
  o: { calendar: boolean; owner: ReturnType<typeof ownerIdentity>; rules: MessageRules },
) {
  const durationSec = rec.videoMediaMetadata?.durationMillis ? Number(rec.videoMediaMetadata.durationMillis) / 1000 : null;
  const created = rec.createdTime ? new Date(rec.createdTime) : ctx.now();
  // Drive stamps the file when the recording is saved, i.e. at its end.
  const startedAt = durationSec ? new Date(created.getTime() - durationSec * 1000) : created;

  // The transcript Doc, as text, stored beside the recording.
  let transcriptText: string | null = null;
  if (doc) {
    try {
      transcriptText = await client.exportText(doc.id);
    } catch (err) {
      ctx.log(`meet:   transcript export failed for ${rec.id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  const parsed = transcriptText ? parseMeetTranscript(transcriptText, durationSec) : null;

  // Who was there: transcript speakers and attendees, then the calendar event's guests.
  const names = new Set<string>([...(parsed?.speakers ?? []), ...(parsed?.attendees ?? [])].filter((n) => n && n.length <= 120));
  const emails = new Map<string, string | null>();
  let eventId: string | null = null;
  if (o.calendar) {
    try {
      const end = new Date(startedAt.getTime() + (durationSec ?? 3600) * 1000);
      const events = await client.events(new Date(startedAt.getTime() - 15 * 60_000), new Date(end.getTime() + 15 * 60_000));
      const ev = events.find((e) => e.hangoutLink || e.conferenceData?.conferenceSolution?.key?.type === "hangoutsMeet") ?? null;
      if (ev) {
        eventId = ev.id;
        for (const a of ev.attendees ?? []) {
          const e = normalizeEmail(a.email ?? "");
          if (e && !a.resource && !isOwner(o.owner, { kind: "email", value: e })) emails.set(e, a.displayName ?? null);
        }
      }
    } catch (err) {
      ctx.log(`meet:   calendar lookup failed for ${rec.id}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  const ownerName = o.owner.name.toLowerCase();
  const byEmail = await matchParties(ctx.pool, [...emails.keys()].map((value) => ({ kind: "email" as const, value })));
  const byName = await matchNames(ctx.pool, [...names].filter((n) => n.toLowerCase() !== ownerName));
  const participantsRaw = [
    ...[...emails.entries()].map(([email, name]) => ({ identifier: email, kind: "email", name, party_id: byEmail.get(email)?.id ?? null })),
    ...[...names].filter((n) => ![...emails.values()].includes(n)).map((n) => ({ identifier: null, kind: "name", name: n, party_id: byName.get(n.toLowerCase())?.id ?? null })),
  ];
  const partyIds = [...new Set(participantsRaw.map((p) => p.party_id).filter((x): x is number => x !== null))];
  const emailParties = new Map<string, PartyRef>();
  for (const [k, v] of byEmail) emailParties.set(k, v);
  const known = new Set((await ctx.pool.query(`select id from workspaces`)).rows.map((r) => r.id as string));
  const route = known.has(INBOX) ? noAutoPhalanx(await routeThread(ctx.pool, partyIds, [...emails.keys()], emailParties, o.rules, known)) : { workspaceId: null as string | null, review: null };

  const target = ctx.storage.archiveTarget;
  const videoKey = meetObjectKey(rec, "recording.mp4");
  let transcriptObj: { key: string; bytes: number; sha256: string } | null = null;
  if (transcriptText) {
    const key = meetObjectKey(rec, "transcript.txt");
    const out = await ctx.storage.putStream({ key, body: Readable.from(Buffer.from(transcriptText, "utf8")), contentType: "text/plain; charset=utf-8" });
    transcriptObj = { key, ...out };
  }

  const db = await ctx.pool.connect();
  try {
    await db.query("begin");
    const vaultId = newVaultId();
    const ins = await db.query<{ id: number }>(
      `insert into interactions (vault_id, workspace_id, kind, source, source_ref, title, occurred_at, duration_sec, host_email, participants_raw, source_payload, pipeline_status, pipeline_updated_at)
       values ($1, $2, 'meeting', 'meet', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'queued', now())
       on conflict (source, source_ref) where source_ref is not null do nothing
       returning id`,
      [
        vaultId,
        route.workspaceId,
        `meet:${account.email}:${rec.id}`,
        meetTitle(rec.name).slice(0, 300),
        startedAt,
        durationSec,
        account.email,
        JSON.stringify(participantsRaw),
        JSON.stringify({ account: account.email, drive_file_id: rec.id, drive_id: rec.driveId ?? null, name: rec.name, transcript_file_id: doc?.id ?? null, calendar_event_id: eventId, created_time: rec.createdTime ?? null }),
      ],
    );
    if (!ins.rows[0]) {
      await db.query("rollback");
      return;
    }
    const interactionId = Number(ins.rows[0].id);
    await db.query(
      `insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, kind, role, mime_type, bytes_expected, status, source_file_id, original_filename, recorded_at)
       values ($1, $2, 'meet', $3, $4, $5, 'video', 'original', 'video/mp4', $6, 'pending', $7, $8, $9)
       on conflict (storage, coalesce(bucket, ''), storage_key) do nothing`,
      [interactionId, route.workspaceId, target.storage, target.bucket, videoKey, rec.size ? Number(rec.size) : null, rec.id, rec.name.slice(0, 300), startedAt],
    );
    if (transcriptObj) {
      await db.query(
        `insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, kind, role, mime_type, bytes, bytes_expected, sha256, status, source_file_id, original_filename, recorded_at, verified_at)
         values ($1, $2, 'meet', $3, $4, $5, 'transcript_meet', 'original', 'text/plain', $6, $6, $7, 'verified', $8, $9, $10, now())
         on conflict (storage, coalesce(bucket, ''), storage_key) do nothing`,
        [interactionId, route.workspaceId, target.storage, target.bucket, transcriptObj.key, transcriptObj.bytes, transcriptObj.sha256, doc!.id, doc!.name.slice(0, 300), startedAt],
      );
    }
    for (const id of partyIds) {
      const label = participantsRaw.find((p) => p.party_id === id)?.name ?? null;
      await db.query(`insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values ($1, $2, $3, 0.9) on conflict (interaction_id, party_id) do nothing`, [interactionId, id, label]);
    }
    if (route.review?.suggested) {
      await db.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('workspace_assignment', $1::jsonb, $2, $3, 'open')`, [
        JSON.stringify({ interaction_id: interactionId, workspace_id: route.review.suggested, candidates: route.review.candidates, source: "meet", proposed_at: ctx.now().toISOString() }),
        route.review.reason,
        interactionId,
      ]);
    }
    await db.query("commit");
    ctx.log(`meet:   new recording ${rec.id} (${startedAt.toISOString().slice(0, 10)}${transcriptObj ? ", transcript" : ""}, ${partyIds.length} matched part${partyIds.length === 1 ? "y" : "ies"}, ${route.workspaceId ?? "unfiled"})`);
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

interface PendingFile {
  id: number;
  interaction_id: number;
  storage: string;
  bucket: string | null;
  storage_key: string;
  bytes_expected: number | null;
  source_file_id: string;
  status: string;
  sha256: string | null;
  account: string | null;
}

/** Streams every pending Meet recording from Drive into the archive, hashing, and checks its size (the Zoom step's logic). */
async function downloadPending(ctx: WorkerContext, accounts: MeetAccount[], clients: Map<number, MeetClient>, summary: MeetSyncSummary) {
  const { rows } = await ctx.pool.query<PendingFile>(
    `select m.id, m.interaction_id, m.storage, m.bucket, m.storage_key, m.bytes_expected, m.source_file_id, m.status, m.sha256, i.source_payload->>'account' as account
       from media m join interactions i on i.id = m.interaction_id
      where m.source = 'meet' and m.role = 'original' and m.kind = 'video'
        and (m.status = 'pending' or (m.status = 'failed' and m.attempts < $1))
        and m.storage = $2
      order by i.occurred_at desc nulls last, m.id`,
    [MAX_DOWNLOAD_ATTEMPTS, ctx.storage.archiveTarget.storage],
  );
  for (const file of rows) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const expected = Number(file.bytes_expected ?? 0);
    if (summary.bytes > 0 && summary.bytes + expected > ctx.bytesBudget) {
      summary.stoppedEarly = "byte budget";
      break;
    }
    const account = accounts.find((a) => a.email === file.account);
    const client = account ? clients.get(account.id) : undefined;
    if (!client) continue; // its account is disabled or was not reachable this run
    try {
      const dl = await client.download(file.source_file_id);
      const { bytes, sha256 } = await ctx.storage.putStream({ storage: file.storage, bucket: file.bucket, key: file.storage_key, body: dl.stream, contentType: "video/mp4", contentLength: dl.contentLength ?? (expected || null) });
      summary.bytes += bytes;
      if (expected && bytes !== expected) {
        // A second download that reproduces the digest is stable content (Drive's size can lag an edit).
        const stable = file.status === "failed" && file.sha256 === sha256;
        await mark(ctx, file.id, stable ? "verified_stable" : "failed", bytes, sha256, stable ? `size differs from Drive's (${bytes} vs ${expected}) but the SHA-256 is reproducible` : `size mismatch: got ${bytes}, expected ${expected}`);
        if (!stable) {
          summary.filesFailed++;
          continue;
        }
      } else await mark(ctx, file.id, "verified", bytes, sha256, null);
      summary.filesVerified++;
      await ctx.pool.query(`update interactions set media_id = coalesce(media_id, $2), pipeline_status = coalesce(pipeline_status, 'queued'), pipeline_updated_at = now() where id = $1`, [file.interaction_id, file.id]);
      await ctx.pool.query(`insert into jobs (media_id, stage, status) values ($1, 'transcribe', 'pending') on conflict (media_id, stage) do nothing`, [file.id]);
      ctx.log(`meet:   verified recording ${file.source_file_id} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      await mark(ctx, file.id, "failed", null, null, msg);
      summary.filesFailed++;
      summary.errors.push(`download ${file.source_file_id}: ${msg}`);
    }
  }
}

async function mark(ctx: WorkerContext, id: number, status: string, bytes: number | null, sha256: string | null, error: string | null) {
  await ctx.pool.query(
    `update media set status = $2, bytes = coalesce($3, bytes), sha256 = coalesce($4, sha256), last_error = $5, attempts = attempts + case when $2 = 'failed' then 1 else 0 end,
            verified_at = case when $2 in ('verified', 'verified_stable') then now() else verified_at end
      where id = $1`,
    [id, status, bytes, sha256, error],
  );
}
