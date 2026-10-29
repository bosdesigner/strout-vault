// Zoom sync: what `vault run` did on the Mac, now against Postgres and cold
// storage directly. Two passes per run:
//
//   1. enumerate  - walk the recent months (cursor minus overlap .. today),
//                   upsert an interaction per meeting UUID and a pending media
//                   row per archive-worthy file. Cheap: a handful of API calls.
//   2. download   - stream every pending file from Zoom into the archive
//                   bucket, hashing on the way, and verify the byte count
//                   against what Zoom reported. Resumable: a run that hits its
//                   time or byte budget leaves the rest pending for next hour.
//
// Nothing here deletes anything, at Zoom or in the bucket. A re-download of a
// mismatched file overwrites the same key.

import crypto from "node:crypto";
import type { WorkerContext } from "./context.ts";
import { outOfTime } from "./context.ts";
import { applyFilingRules, loadFilingRules } from "../workspaces/filing.ts";
import { ARCHIVE_KINDS, ZoomClient, monthOf, monthsBefore, stripToken, type Recording, type RecordingFile } from "./zoom.ts";

export interface SyncSummary {
  configured: boolean;
  windows: number;
  recordingsSeen: number;
  recordingsNew: number;
  filesQueued: number;
  filesVerified: number;
  filesStable: number;
  filesFailed: number;
  bytes: number;
  cursor: string | null;
  stoppedEarly?: string;
  errors: string[];
}

const CURSOR_KEY = "zoom_cursor_month";
const MAX_DOWNLOAD_ATTEMPTS = 4;

/** The bucket refused our write (bad key, no capability). Not the file's fault, so it does not use up the file's retries. */
export class StorageWriteError extends Error {}
// Small files first so a meeting's transcript and audio land before its video.
const KIND_ORDER: Record<string, number> = { transcript_vtt: 0, caption_vtt: 1, chat: 2, audio: 3, video: 4 };

export function zoomConfigured(ctx: WorkerContext): boolean {
  const c = ctx.config;
  return !!(c.ZOOM_ACCOUNT_ID && c.ZOOM_CLIENT_ID && c.ZOOM_CLIENT_SECRET);
}

const zoomClients = new WeakMap<WorkerContext, ZoomClient>();

/** One Zoom client (and token) per run, shared by the sync and the resolve step. */
export function makeZoomClient(ctx: WorkerContext): ZoomClient {
  const cached = zoomClients.get(ctx);
  if (cached) return cached;
  const c = ctx.config;
  const client = new ZoomClient({
    accountId: c.ZOOM_ACCOUNT_ID!,
    clientId: c.ZOOM_CLIENT_ID!,
    clientSecret: c.ZOOM_CLIENT_SECRET!,
    apiBase: c.ZOOM_API_BASE,
    oauthBase: c.ZOOM_OAUTH_BASE,
    fetchImpl: ctx.fetchImpl,
    sleep: ctx.sleep,
    now: ctx.now,
  });
  zoomClients.set(ctx, client);
  return client;
}

export async function syncZoom(ctx: WorkerContext, opts: { dryRun?: boolean } = {}): Promise<SyncSummary> {
  const summary: SyncSummary = {
    configured: zoomConfigured(ctx),
    windows: 0,
    recordingsSeen: 0,
    recordingsNew: 0,
    filesQueued: 0,
    filesVerified: 0,
    filesStable: 0,
    filesFailed: 0,
    bytes: 0,
    cursor: null,
    errors: [],
  };
  if (!summary.configured) {
    ctx.log("zoom: skipped (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set)");
    return summary;
  }
  const client = makeZoomClient(ctx);

  // ---- 1. enumerate -------------------------------------------------------
  const thisMonth = monthOf(ctx.now());
  const cursor = await getState<{ month: string }>(ctx, CURSOR_KEY);
  summary.cursor = cursor?.month ?? null;
  const overlap = ctx.config.ZOOM_SYNC_OVERLAP_MONTHS;
  const startMonth = cursor?.month ? monthsBefore(cursor.month, overlap) : (ctx.config.ZOOM_SYNC_FROM ?? monthsBefore(thisMonth, overlap));
  ctx.log(`zoom: enumerating ${startMonth} .. ${thisMonth}${cursor?.month ? ` (cursor ${cursor.month}, overlap ${overlap} months)` : " (first run)"}`);
  let enumerated = false;
  try {
    for await (const rec of client.iterWindows(startMonth, thisMonth, (from, to, found) => {
      summary.windows++;
      ctx.log(`zoom:   ${from} .. ${to}  ${found} recording(s)`);
    })) {
      summary.recordingsSeen++;
      if (opts.dryRun) continue;
      const r = await recordRecording(ctx, rec);
      if (r.created) summary.recordingsNew++;
      summary.filesQueued += r.filesQueued;
    }
    enumerated = true;
  } catch (err) {
    summary.errors.push(`enumerate: ${(err as Error).message}`);
    ctx.log(`zoom: enumeration stopped: ${(err as Error).message}`);
  }
  if (enumerated && !opts.dryRun) {
    await setState(ctx, CURSOR_KEY, { month: thisMonth, updatedAt: ctx.now().toISOString() });
    summary.cursor = thisMonth;
  }
  if (opts.dryRun) return summary;

  // ---- 2. download --------------------------------------------------------
  const { rows: pending } = await ctx.pool.query<PendingRow>(
    `select m.id, m.interaction_id, m.kind, m.storage, m.bucket, m.storage_key, m.bytes_expected, m.source_file_id, m.attempts, m.sha256, m.mime_type, m.status,
            i.title, i.source_payload
       from media m join interactions i on i.id = m.interaction_id
      where m.source = 'zoom' and m.role = 'original'
        and (m.status = 'pending' or (m.status = 'failed' and m.attempts < $1))
        and m.storage = $2
      order by i.occurred_at desc nulls last, m.id`,
    [MAX_DOWNLOAD_ATTEMPTS, ctx.storage.archiveTarget.storage],
  );
  pending.sort((a, b) => (a.interaction_id === b.interaction_id ? (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) : 0));
  if (pending.length) ctx.log(`zoom: ${pending.length} file(s) to download`);
  for (const file of pending) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const expected = Number(file.bytes_expected ?? 0);
    if (summary.bytes > 0 && summary.bytes + expected > ctx.bytesBudget) {
      summary.stoppedEarly = "byte budget";
      break;
    }
    const url = downloadUrlFor(file);
    if (!url) {
      await markFile(ctx, file.id, { status: "failed", error: "no download_url in the recording's payload" });
      summary.filesFailed++;
      continue;
    }
    try {
      const r = await downloadAndVerify(ctx, client, file, url, expected);
      summary.bytes += r.bytes;
      if (r.status === "verified") summary.filesVerified++;
      else if (r.status === "verified_stable") summary.filesStable++;
      else summary.filesFailed++;
      if (r.status !== "failed") await afterVerified(ctx, file);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await markFile(ctx, file.id, { status: "failed", error: msg, countAttempt: !(err instanceof StorageWriteError) });
      summary.filesFailed++;
      summary.errors.push(`download ${file.kind} for "${file.title ?? file.interaction_id}": ${msg}`);
      ctx.log(`zoom:   failed ${file.kind} (${file.title ?? file.interaction_id}): ${msg}`);
      if (err instanceof StorageWriteError) {
        // Every later file would fail the same way; stop and let the next run try again.
        summary.stoppedEarly = "storage refused writes";
        break;
      }
    }
  }
  return summary;
}

interface PendingRow {
  id: number;
  interaction_id: number;
  kind: string;
  storage: string;
  bucket: string | null;
  storage_key: string;
  bytes_expected: number | null;
  source_file_id: string | null;
  attempts: number;
  sha256: string | null;
  mime_type: string | null;
  status: string;
  title: string | null;
  source_payload: Record<string, unknown> | null;
}

/** The Zoom download URL for a media row, from the recording payload stored on its interaction. */
function downloadUrlFor(file: PendingRow): string | null {
  const files = (file.source_payload?.recording_files as Array<Record<string, unknown>> | undefined) ?? [];
  const hit = files.find((f) => String(f.id ?? "") === String(file.source_file_id ?? ""));
  const url = hit?.download_url ? String(hit.download_url) : null;
  return url && /^https:\/\//.test(url) ? url : null;
}

async function downloadAndVerify(ctx: WorkerContext, client: ZoomClient, file: PendingRow, url: string, expected: number) {
  let lastSha: string | null = file.status === "failed" ? file.sha256 : null;
  let result: { status: "verified" | "verified_stable" | "failed"; bytes: number } = { status: "failed", bytes: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const dl = await client.openDownload(url);
    let bytes: number;
    let sha256: string;
    try {
      ({ bytes, sha256 } = await ctx.storage.putStream({
        storage: file.storage,
        bucket: file.bucket,
        key: file.storage_key,
        body: dl.stream,
        contentType: file.mime_type,
        contentLength: dl.contentLength ?? (expected || null),
      }));
    } catch (err) {
      // Say which side failed: Zoom errors already read "HTTP 4xx downloading …".
      const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode ? ` HTTP ${e.$metadata.httpStatusCode}` : "";
      throw new StorageWriteError(`storage ${file.storage}${file.bucket ? ` (${file.bucket})` : ""} refused the write:${status} ${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`.trim());
    }
    if (!expected || bytes === expected) {
      await markFile(ctx, file.id, { status: "verified", bytes, sha256 });
      ctx.log(`zoom:   verified ${file.kind} ${fmtBytes(bytes)} (${file.title ?? file.interaction_id})`);
      return { status: "verified" as const, bytes };
    }
    // Size disagreement. Zoom's reported size is sometimes wrong for small text
    // artifacts; if a second fetch reproduces the same digest the content is stable.
    if (lastSha && lastSha === sha256) {
      const note = `size differs from Zoom's report (${bytes} stored vs ${expected} reported) but the SHA-256 is reproducible across downloads`;
      await markFile(ctx, file.id, { status: "verified_stable", bytes, sha256, error: note });
      ctx.log(`zoom:   verified (stable) ${file.kind} ${fmtBytes(bytes)} (${file.title ?? file.interaction_id})`);
      return { status: "verified_stable" as const, bytes };
    }
    lastSha = sha256;
    result = { status: "failed", bytes };
    await markFile(ctx, file.id, { status: "failed", bytes, sha256, error: `size mismatch: got ${bytes}, expected ${expected}` });
  }
  ctx.log(`zoom:   size mismatch ${file.kind} (${file.title ?? file.interaction_id}); will retry next run`);
  return result;
}

async function markFile(ctx: WorkerContext, id: number, patch: { status: string; bytes?: number; sha256?: string; error?: string | null; countAttempt?: boolean }) {
  await ctx.pool.query(
    `update media set status = $2, bytes = coalesce($3, bytes), sha256 = coalesce($4, sha256), last_error = $5,
            attempts = attempts + $6, verified_at = case when $2 in ('verified','verified_stable') then now() else verified_at end
      where id = $1`,
    [id, patch.status, patch.bytes ?? null, patch.sha256 ?? null, patch.error ?? null, patch.countAttempt === false ? 0 : 1],
  );
}

/** Once a file is in the bucket: point the interaction at its primary media and queue the transcription job. */
async function afterVerified(ctx: WorkerContext, file: PendingRow) {
  if (file.kind !== "video" && file.kind !== "audio") return;
  await ctx.pool.query(
    `update interactions i set media_id = coalesce(i.media_id, $2), pipeline_status = coalesce(i.pipeline_status, 'queued'),
            pipeline_updated_at = coalesce(i.pipeline_updated_at, now())
      where i.id = $1`,
    [file.interaction_id, file.id],
  );
  // One transcribe job per interaction, on whichever AV file arrived first.
  const { rows } = await ctx.pool.query(
    `select 1 from jobs j join media m on m.id = j.media_id where m.interaction_id = $1 and j.stage = 'transcribe' limit 1`,
    [file.interaction_id],
  );
  if (!rows.length) {
    await ctx.pool.query(
      `insert into jobs (media_id, stage, status) values ($1, 'transcribe', 'pending'), ($1, 'extract', 'pending') on conflict (media_id, stage) do nothing`,
      [file.id],
    );
  }
}

/** Upsert one Zoom recording as an interaction plus pending media rows. Idempotent by UUID and file id. */
export async function recordRecording(ctx: WorkerContext, rec: Recording): Promise<{ interactionId: number | null; created: boolean; filesQueued: number }> {
  const files = rec.files.filter((f) => (ARCHIVE_KINDS as readonly string[]).includes(f.kind) && f.status === "completed" && f.downloadUrl);
  if (!files.length || !rec.uuid) return { interactionId: null, created: false, filesQueued: 0 };
  const target = ctx.storage.archiveTarget;
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: number }>(`select id from interactions where source = 'zoom' and source_ref = $1 for update`, [rec.uuid]);
    let interactionId: number;
    let created = false;
    const occurredAt = rec.startTime ? new Date(rec.startTime) : null;
    const payload = sanitizedPayload(rec);
    if (existing.rows[0]) {
      interactionId = existing.rows[0].id;
      // Keep the stored payload current: Zoom adds files after the first sighting.
      await client.query(`update interactions set source_payload = $2, updated_at = now() where id = $1`, [interactionId, payload]);
    } else {
      const vaultId = await freshVaultId(client);
      const ins = await client.query<{ id: number }>(
        `insert into interactions (vault_id, kind, source, source_ref, title, occurred_at, duration_sec, host_email, source_payload, pipeline_status, pipeline_updated_at)
         values ($1, 'meeting', 'zoom', $2, $3, $4, $5, $6, $7, 'queued', now()) returning id`,
        [vaultId, rec.uuid, rec.topic, occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null, rec.durationMin ? rec.durationMin * 60 : null, rec.hostEmail || null, payload],
      );
      interactionId = ins.rows[0].id;
      created = true;
      // File it by title right away (config/filing_rules.yml); the resolve step does the rest once it is transcribed.
      await applyFilingRules(client, loadFilingRules(ctx.config.MESSAGES_CONFIG_DIR), { id: interactionId, title: rec.topic, source: "zoom" });
    }
    let filesQueued = 0;
    for (const f of files) {
      const dup = await client.query(`select 1 from media where interaction_id = $1 and source_file_id = $2`, [interactionId, f.fileId]);
      if (dup.rowCount) continue;
      const key = zoomObjectKey(rec, f);
      await client.query(
        `insert into media (interaction_id, source, storage, bucket, storage_key, kind, role, mime_type, bytes_expected, status, source_file_id, original_filename, recorded_at)
         values ($1, 'zoom', $2, $3, $4, $5, 'original', $6, $7, 'pending', $8, $9, $10)
         on conflict (storage, coalesce(bucket, ''), storage_key) do nothing`,
        [
          interactionId,
          target.storage,
          target.bucket,
          key,
          f.kind,
          mimeFor(f.extension),
          f.size || null,
          f.fileId,
          `${f.kind}.${f.extension}`,
          f.recordingStart ? new Date(f.recordingStart) : null,
        ],
      );
      filesQueued++;
    }
    await client.query("commit");
    if (created) ctx.log(`zoom:   new recording "${rec.topic}" (${rec.startTime.slice(0, 10)}, ${files.length} file(s))`);
    return { interactionId, created, filesQueued };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The recording payload as Zoom sent it, minus anything that could carry a token. */
function sanitizedPayload(rec: Recording): Record<string, unknown> {
  const raw = { ...rec.raw };
  if (Array.isArray(raw.recording_files)) {
    raw.recording_files = (raw.recording_files as Array<Record<string, unknown>>).map((f) => ({
      ...f,
      download_url: f.download_url ? stripToken(String(f.download_url)) : f.download_url,
      play_url: undefined,
    }));
  }
  delete raw.share_url;
  delete raw.password;
  delete raw.recording_play_passcode;
  return raw;
}

/** meeting-vault/<yyyy>/<yyyy-mm-dd>_z<uuid slug>/original/<kind>_<file id>.<ext>, next to the legacy archive. */
export function zoomObjectKey(rec: Recording, f: RecordingFile): string {
  const start = rec.startTime ? new Date(rec.startTime) : null;
  const ok = start && !Number.isNaN(start.getTime());
  const yyyy = ok ? String(start.getUTCFullYear()) : "unknown";
  const day = ok ? start.toISOString().slice(0, 10) : "unknown-date";
  const slug = rec.uuid.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "x";
  const fid = f.fileId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "f";
  const ext = f.extension.replace(/[^a-z0-9]/g, "") || "bin";
  return `meeting-vault/${yyyy}/${day}_z${slug}/original/${f.kind}_${fid}.${ext}`;
}

export function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case "mp4":
      return "video/mp4";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    case "vtt":
      return "text/vtt";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newVaultId(): string {
  const bytes = crypto.randomBytes(9);
  let s = "v";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

async function freshVaultId(client: { query: (q: string, p?: unknown[]) => Promise<{ rowCount: number | null }> }): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const id = newVaultId();
    const r = await client.query(`select 1 from interactions where vault_id = $1`, [id]);
    if (!r.rowCount) return id;
  }
  throw new Error("could not allocate a vault id");
}

export async function getState<T>(ctx: WorkerContext, key: string): Promise<T | null> {
  const { rows } = await ctx.pool.query(`select value from worker_state where key = $1`, [key]);
  return (rows[0]?.value as T | undefined) ?? null;
}

export async function setState(ctx: WorkerContext, key: string, value: unknown): Promise<void> {
  await ctx.pool.query(
    `insert into worker_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
