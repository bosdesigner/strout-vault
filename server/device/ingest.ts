// The device ingest: Voice Memos, iPhone call recordings and Apple Notes from the Mac media
// collector (collectors/apple-media) and the iPhone "Send to Vault" Shortcut
// (collectors/ios/SHORTCUT.md). Both authenticate with an ingest:device token and go through the
// same path as a web upload:
//
//   presign   duplicate check by (source, source_ref) and by sha256 against every media row; then
//             a multipart upload under uploads/device/<yyyy>/<mm>/<uuid>/<filename>, its part URLs
//             presigned. File bytes go straight to R2; they never pass through this server.
//   finalize  completes the upload from the storage's own part list (a Shortcut cannot read
//             ETags), matches the counterparty to a party, routes, then calls finishUpload (the
//             web upload's transaction: interactions, media, transcribe + extract jobs,
//             participants). The worker's transcribe and embed steps take it from there.
//   note      Apple Notes text: no media; redacted, upserted by (source, source_ref), one segment
//             per paragraph, pipeline_status 'ready' and a fresh pipeline_updated_at so the
//             existing embedding step (re)embeds it. An edited note updates the same row.
//   runs      one import_runs row per collector batch, counts only.
//
// Routing is the messages routing (server/messages/ingest.ts routeThread): exactly one workspace
// files the item; several, or phalanx (always), go to `inbox` with a workspace_assignment review
// row; none goes to `inbox` with no review row. Nothing here logs or returns note or transcript
// text: responses and import_runs carry ids and counts.
import crypto from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { StorageDriver } from "../storage/types.ts";
import { sanitizeFilename } from "../storage/types.ts";
import { finishUpload, kindFromMime, UploadError } from "../services/upload.ts";
import { redactSensitive } from "../messages/redact.ts";
import { normalizeIdentifier, isOwner, type Identifier, type OwnerIdentity } from "../messages/identity.ts";
import { INBOX, matchParties, routeThread, type PartyRef, type RouteDecision } from "../messages/ingest.ts";
import type { MessageRules } from "../messages/rules.ts";
import type { TokenPurpose } from "../mcp/auth/tokens.ts";

export const DEVICE_FILE_SOURCES = ["voice_memo", "iphone_call"] as const;
export type DeviceFileSource = (typeof DEVICE_FILE_SOURCES)[number];
export const DEVICE_SOURCES = [...DEVICE_FILE_SOURCES, "apple_note"] as const;
export type DeviceSource = (typeof DEVICE_SOURCES)[number];
/** import_runs.source per collector. */
export const RUN_SOURCE: Record<"mac_media" | "ios_shortcut", string> = { mac_media: "apple_media", ios_shortcut: "ios_shortcut" };
export const DEVICE_AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "aac", "caf", "qta", "mp4", "mov"];

/** One PUT up to this size; above it, parts of DEVICE_PART_BYTES. A Shortcut always sends one PUT. */
export const SINGLE_PUT_MAX_BYTES = 512 * 1024 * 1024;
export const DEVICE_PART_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

const sha = z.string().regex(/^[a-f0-9]{64}$/i, "sha256 must be 64 hex characters");
const sourceRef = z.string().trim().min(1).max(300).regex(/^[\x21-\x7e]+$/, "source_ref must be printable ASCII without spaces");
const runId = z.coerce.number().int().positive().optional();

export const presignSchema = z.object({
  source: z.enum(DEVICE_FILE_SOURCES),
  source_ref: sourceRef,
  sha256: sha,
  bytes: z.number().int().positive().max(MAX_BYTES),
  content_type: z.string().max(200).nullable().optional(),
  filename: z.string().min(1).max(300),
  /** Ask for one part whatever the size (the Shortcut). */
  single_part: z.boolean().optional(),
});

const participant = z.object({
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
});

export const finalizeSchema = z.object({
  source: z.enum(DEVICE_FILE_SOURCES),
  source_ref: sourceRef,
  sha256: sha,
  bytes: z.number().int().positive().max(MAX_BYTES),
  key: z.string().min(1).max(1024),
  upload_id: z.string().min(1).max(2048),
  content_type: z.string().max(200).nullable().optional(),
  filename: z.string().min(1).max(300),
  occurred_at: z.string().min(4).max(40),
  duration_sec: z.number().nonnegative().max(7 * 24 * 3600).nullable().optional(),
  title: z.string().max(300).nullable().optional(),
  participants_raw: z.array(participant).max(20).nullable().optional(),
  source_payload: z.record(z.unknown()).nullable().optional(),
  run_id: runId,
});

export const noteSchema = z.object({
  source: z.literal("apple_note"),
  source_ref: sourceRef,
  occurred_at: z.string().min(4).max(40),
  modified_at: z.string().min(4).max(40).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  folder: z.string().max(200).nullable().optional(),
  text: z.string().max(2_000_000),
  source_payload: z.record(z.unknown()).nullable().optional(),
  run_id: runId,
});

/** Who was on a call the collector already sent (found later, e.g. in the Mac's call history). */
export const participantsSchema = z.object({
  source: z.enum(DEVICE_FILE_SOURCES),
  source_ref: sourceRef,
  participants_raw: z.array(participant).min(1).max(20),
  run_id: runId,
});

export const runStartSchema = z.object({
  collector: z.object({ name: z.string().max(60), version: z.string().max(40).optional(), host: z.string().max(200).optional() }).optional(),
  counts_in: z.record(z.unknown()).optional(),
});

export const runFinishSchema = z.object({
  counts_in: z.record(z.unknown()).optional(),
  ok: z.boolean().optional(),
  error: z.string().max(500).nullable().optional(),
});

export type PresignInput = z.infer<typeof presignSchema>;
export type FinalizeInput = z.infer<typeof finalizeSchema>;
export type NoteInput = z.infer<typeof noteSchema>;

export interface DeviceDeps {
  pool: pg.Pool;
  storage: StorageDriver;
  owner: OwnerIdentity;
  rules: MessageRules;
  /** Absolute origin for local-driver part URLs (development and tests). */
  baseUrl: string;
}

export interface DeviceCaller {
  tokenId: number;
  purpose: TokenPurpose | null;
}

export interface DuplicateAnswer {
  duplicate: true;
  interaction_id: number | null;
}

export class DeviceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function via(caller: DeviceCaller): "mac_collector" | "ios_shortcut" {
  return caller.purpose === "ios_shortcut" ? "ios_shortcut" : "mac_collector";
}

function runSource(caller: DeviceCaller): string {
  return caller.purpose === "ios_shortcut" ? RUN_SOURCE.ios_shortcut : RUN_SOURCE.mac_media;
}

/** uploads/device/<yyyy>/<mm>/<uuid>/<filename> */
export function deviceKey(filename: string, now: Date, uuid: string): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `uploads/device/${yyyy}/${mm}/${uuid}/${sanitizeFilename(filename)}`;
}

function extensionOk(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return DEVICE_AUDIO_EXTENSIONS.includes(ext);
}

/** The interaction this item already is: same (source, source_ref), or the same bytes anywhere in media. */
export async function findExisting(db: pg.Pool | pg.PoolClient, source: string, ref: string, sha256: string | null): Promise<DuplicateAnswer | null> {
  const byRef = await db.query(`select id from interactions where source = $1 and source_ref = $2 limit 1`, [source, ref]);
  if (byRef.rows[0]) return { duplicate: true, interaction_id: Number(byRef.rows[0].id) };
  if (!sha256) return null;
  const bySha = await db.query(`select interaction_id from media where sha256 = $1 order by (interaction_id is null), id limit 1`, [sha256.toLowerCase()]);
  if (bySha.rows[0]) return { duplicate: true, interaction_id: bySha.rows[0].interaction_id == null ? null : Number(bySha.rows[0].interaction_id) };
  return null;
}

export interface PresignAnswer {
  duplicate: false;
  key: string;
  upload_id: string;
  part_size: number;
  parts: Array<{ part_number: number; url: string; method: "PUT"; headers: Record<string, string> }>;
  expires_at: string;
}

export async function presignDevice(deps: DeviceDeps, input: PresignInput): Promise<PresignAnswer | DuplicateAnswer> {
  if (!extensionOk(input.filename)) throw new DeviceError(415, "unsupported_type", `accepted: ${DEVICE_AUDIO_EXTENSIONS.join(", ")}`);
  const existing = await findExisting(deps.pool, input.source, input.source_ref, input.sha256);
  if (existing) return existing;
  const key = deviceKey(input.filename, new Date(), crypto.randomUUID());
  const single = input.single_part || input.bytes <= SINGLE_PUT_MAX_BYTES;
  const partSize = single ? input.bytes : Math.max(DEVICE_PART_BYTES, Math.ceil(input.bytes / 10_000));
  const count = single ? 1 : Math.ceil(input.bytes / partSize);
  const { uploadId } = await deps.storage.createMultipartUpload({ key, contentType: input.content_type ?? null });
  const parts: PresignAnswer["parts"] = [];
  let expires = Date.now() + 3600_000;
  for (let n = 1; n <= count; n++) {
    const signed = await deps.storage.signPart({ key, uploadId, partNumber: n });
    expires = Math.min(expires, signed.expiresAt.getTime());
    parts.push({ part_number: n, url: absolutePartUrl(deps, signed.url), method: "PUT", headers: signed.headers ?? {} });
  }
  return { duplicate: false, key, upload_id: uploadId, part_size: partSize, parts, expires_at: new Date(expires).toISOString() };
}

/** The local driver signs relative URLs behind the session check; device clients use the token-free twin. */
function absolutePartUrl(deps: DeviceDeps, url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${deps.baseUrl.replace(/\/$/, "")}${url.replace(/^\/api\/storage\/local\/part/, "/api/ingest/device/local/part")}`;
}

export interface FinalizeAnswer {
  duplicate: boolean;
  interaction_id: number | null;
  media_id?: number;
  workspace_id?: string;
  review_queued?: boolean;
}

export async function finalizeDevice(deps: DeviceDeps, caller: DeviceCaller, input: FinalizeInput): Promise<FinalizeAnswer> {
  if (!input.key.startsWith("uploads/device/")) throw new DeviceError(400, "bad_key", "key must come from /presign");
  if (!extensionOk(input.filename)) throw new DeviceError(415, "unsupported_type", `accepted: ${DEVICE_AUDIO_EXTENSIONS.join(", ")}`);
  const occurredAt = new Date(input.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) throw new DeviceError(400, "bad_date", "occurred_at is not a date");

  const existing = await findExisting(deps.pool, input.source, input.source_ref, input.sha256);
  if (existing) {
    await deps.storage.abortMultipartUpload({ key: input.key, uploadId: input.upload_id }).catch(() => {});
    await countItem(deps.pool, caller, input.run_id, input.source, "duplicate");
    return { duplicate: true, interaction_id: existing.interaction_id };
  }

  await completeUpload(deps.storage, input.key, input.upload_id);

  // Who was on it: phones/emails match parties exactly; a name alone matches one person of that name.
  const people = await identifyParticipants(deps.pool, input.participants_raw ?? [], deps.owner);
  const route = await routeThread(deps.pool, people.partyIds, people.emails, people.byEmail, deps.rules, await knownWorkspaces(deps.pool));
  const decision = noAutoPhalanx(route);
  const title = redactSensitive((input.title ?? "").trim()).text.slice(0, 300) || defaultTitle(input.source, people.names, occurredAt);
  const payload: Record<string, unknown> = { ...(redactPayload(input.source_payload) ?? {}), via: via(caller), filename: sanitizeFilename(input.filename) };

  try {
    const out = await finishUpload(deps.pool, deps.storage, {
      key: input.key,
      sha256: input.sha256,
      bytes: input.bytes,
      mimeType: input.content_type ?? mimeFromName(input.filename),
      originalFilename: sanitizeFilename(input.filename),
      title,
      recordedAt: occurredAt.toISOString(),
      workspaceId: decision.workspaceId,
      source: input.source,
      partyIds: people.partyIds,
      sourceRef: input.source_ref,
      durationSec: input.duration_sec ?? null,
      participantsRaw: people.raw,
      sourcePayload: payload,
    });
    const queued = decision.review?.suggested ? await queueWorkspaceReview(deps.pool, out.interactionId, decision) : false;
    await countItem(deps.pool, caller, input.run_id, input.source, "created");
    return { duplicate: false, interaction_id: out.interactionId, media_id: out.mediaId, workspace_id: decision.workspaceId, review_queued: queued };
  } catch (err) {
    if (err instanceof UploadError && err.code === "duplicate") {
      await countItem(deps.pool, caller, input.run_id, input.source, "duplicate");
      const d = err.extra.duplicate as { interactionId: number | null } | undefined;
      return { duplicate: true, interaction_id: d?.interactionId ?? null };
    }
    await countItem(deps.pool, caller, input.run_id, input.source, "error", err instanceof UploadError ? err.code : "internal_error");
    if (err instanceof UploadError) throw new DeviceError(err.status, err.code, err.message);
    throw err;
  }
}

/** Completes the multipart upload from the storage's own part list. A retried finalize finds it already complete. */
async function completeUpload(storage: StorageDriver, key: string, uploadId: string): Promise<void> {
  let parts;
  try {
    parts = await storage.listParts({ key, uploadId });
  } catch {
    parts = null;
  }
  if (parts && parts.length) {
    await storage.completeMultipartUpload({ key, uploadId, parts });
    return;
  }
  const head = await storage.head({ storage: storage.uploadTarget.storage, bucket: storage.uploadTarget.bucket, key });
  if (!head) throw new DeviceError(409, "object_missing", "nothing was uploaded for this key; PUT the parts from /presign first");
}

function mimeFromName(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ({ m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", caf: "audio/x-caf", qta: "audio/mp4", mp4: "video/mp4", mov: "video/quicktime" } as Record<string, string>)[ext] ?? `${kindFromMime(null, filename)}/${ext || "octet-stream"}`;
}

function defaultTitle(source: DeviceFileSource, names: string[], at: Date): string {
  const day = at.toISOString().slice(0, 10);
  if (source === "iphone_call") return `Call with ${names[0] ?? "unknown"} · ${day}`;
  return `Voice memo · ${day}`;
}

/** Apple's own transcript and any names in the payload get the same redaction as everything else. */
function redactPayload(p: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!p) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === "string") out[k] = redactSensitive(v.replace(/\u0000/g, "")).text.slice(0, 200_000);
    else if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.parse(redactSensitive(JSON.stringify(v)).text);
  }
  delete out.via;
  return out;
}

interface Participants {
  partyIds: number[];
  emails: string[];
  byEmail: Map<string, PartyRef>;
  names: string[];
  raw: Array<Record<string, unknown>>;
}

async function identifyParticipants(pool: pg.Pool, list: NonNullable<FinalizeInput["participants_raw"]>, owner: OwnerIdentity): Promise<Participants> {
  const ids: Identifier[] = [];
  const rows = list.map((p) => {
    const phone = normalizeIdentifier(p.phone ?? null);
    const email = normalizeIdentifier(p.email ?? null);
    const id = [phone, email].find((x): x is Identifier => !!x && (x.kind === "phone" || x.kind === "email")) ?? null;
    if (id && !isOwner(owner, id)) ids.push(id);
    return { name: p.name ? redactSensitive(p.name.trim()).text.slice(0, 200) || null : null, id: id && !isOwner(owner, id) ? id : null };
  });
  const matched = await matchParties(pool, ids);
  const byName = await matchNames(pool, rows.filter((r) => !r.id || !matched.has(r.id.value)).map((r) => r.name).filter((n): n is string => !!n));
  const raw = rows.map((r) => {
    const party = (r.id ? matched.get(r.id.value) : undefined) ?? (r.name ? byName.get(r.name.toLowerCase()) : undefined);
    return { identifier: r.id?.value ?? null, kind: r.id?.kind ?? (r.name ? "name" : null), name: r.name, party_id: party?.id ?? null };
  });
  const byEmail = new Map<string, PartyRef>();
  for (const [k, v] of matched) if (k.includes("@")) byEmail.set(k, v);
  return {
    partyIds: [...new Set(raw.map((r) => r.party_id).filter((x): x is number => x !== null))],
    emails: rows.filter((r) => r.id?.kind === "email").map((r) => r.id!.value),
    byEmail,
    names: raw.map((r) => (r.party_id ? [...matched.values(), ...byName.values()].find((p) => p.id === r.party_id)?.name : null) ?? r.name ?? r.identifier ?? "").filter(Boolean) as string[],
    raw,
  };
}

/** A contact name from the phone matches a person only when exactly one person has that name. Never creates one. */
export async function matchNames(pool: pg.Pool, names: string[]): Promise<Map<string, PartyRef>> {
  const out = new Map<string, PartyRef>();
  const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter((n) => n.length >= 3))];
  if (!wanted.length) return out;
  const { rows } = await pool.query(
    `select lower(name) as key, min(id) as id, min(name) as name, count(*)::int as n from parties where kind = 'person' and lower(name) = any($1::text[]) group by lower(name)`,
    [wanted],
  );
  for (const r of rows) if (r.n === 1) out.set(r.key, { id: Number(r.id), name: r.name });
  return out;
}

async function knownWorkspaces(pool: pg.Pool): Promise<Set<string>> {
  const known = new Set((await pool.query(`select id from workspaces`)).rows.map((r) => r.id as string));
  if (!known.has(INBOX)) throw new DeviceError(503, "schema_missing", `workspace "${INBOX}" does not exist: apply db/migrations/0009_messages.sql`);
  return known;
}

/**
 * routeThread already sends phalanx to inbox. This is the device ingest's own guard on top of it, so
 * no future change to the messages routing can file a device item under phalanx automatically.
 */
export function noAutoPhalanx(route: RouteDecision): RouteDecision {
  if (route.workspaceId !== "phalanx") return route;
  return { workspaceId: INBOX, review: { suggested: "phalanx", candidates: ["phalanx"], reason: "phalanx is never assigned automatically" } };
}

async function queueWorkspaceReview(pool: pg.Pool, interactionId: number, route: RouteDecision): Promise<boolean> {
  if (!route.review) return false;
  const dup = await pool.query(`select 1 from review_queue where item_type = 'workspace_assignment' and interaction_id = $1`, [interactionId]);
  if (dup.rowCount) return false;
  await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('workspace_assignment', $1::jsonb, $2, $3, 'open')`, [
    JSON.stringify({ interaction_id: interactionId, workspace_id: route.review.suggested, candidates: route.review.candidates, source: "device", proposed_at: new Date().toISOString() }),
    route.review.reason,
    interactionId,
  ]);
  return true;
}

// ------------------------------------------------------------------- notes --

export interface NoteAnswer {
  interaction_id: number | null;
  status: "created" | "updated" | "unchanged" | "empty";
  workspace_id?: string;
  review_queued?: boolean;
}

/** Paragraphs of a note, each one segment (long paragraphs split near 2,000 characters). */
export function noteParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n/g, "\n").split(/\n\s*\n|\n(?=\s*[-•*]\s)/)) {
    let p = para.replace(/[ \t]+\n/g, "\n").trim();
    while (p.length > 2000) {
      const cut = Math.max(p.lastIndexOf(". ", 2000), p.lastIndexOf("\n", 2000), 1000);
      out.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

export async function upsertNote(deps: DeviceDeps, caller: DeviceCaller, input: NoteInput): Promise<NoteAnswer> {
  const occurredAt = new Date(input.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) throw new DeviceError(400, "bad_date", "occurred_at is not a date");
  const clean = (s: string) => s.replace(/\u0000/g, "").replace(/￼/g, "");
  const text = redactSensitive(clean(input.text)).text.trim();
  const title = redactSensitive(clean(input.title ?? "")).text.trim().slice(0, 300) || text.split("\n")[0].slice(0, 120) || "Untitled note";
  const paragraphs = noteParagraphs(text);
  const existing = await deps.pool.query(`select id, workspace_id, content_sha256 from interactions where source = 'apple_note' and source_ref = $1`, [input.source_ref]);
  const row = existing.rows[0];
  if (!paragraphs.length && !row) {
    await countItem(deps.pool, caller, input.run_id, "apple_note", "empty");
    return { interaction_id: null, status: "empty" };
  }
  const contentSha = crypto.createHash("sha256").update(`${title}\u0000${text}`).digest("hex");
  if (row && row.content_sha256 === contentSha) {
    await countItem(deps.pool, caller, input.run_id, "apple_note", "unchanged");
    return { interaction_id: Number(row.id), status: "unchanged", workspace_id: row.workspace_id };
  }
  let decision: RouteDecision | null = null;
  if (!row) {
    const folder = (input.folder ?? "").trim().toLowerCase();
    const ruled = folder ? deps.rules.routing.notesFolders.get(folder) : undefined;
    const known = await knownWorkspaces(deps.pool);
    decision = ruled && known.has(ruled) && ruled !== INBOX
      ? noAutoPhalanx({ workspaceId: ruled, review: null })
      : { workspaceId: INBOX, review: null };
  }
  const payload = {
    ...(redactPayload(input.source_payload) ?? {}),
    via: via(caller),
    folder: input.folder ? redactSensitive(input.folder).text.slice(0, 200) : null,
    modified_at: input.modified_at ?? null,
    paragraphs: paragraphs.length,
    characters: text.length,
  };
  const db = await deps.pool.connect();
  try {
    await db.query("begin");
    const ins = await db.query<{ id: number; inserted: boolean; workspace_id: string | null }>(
      `insert into interactions (workspace_id, kind, occurred_at, title, transcript, source, source_ref, content_sha256, source_payload, pipeline_status, pipeline_updated_at, updated_at)
       values ($1, 'note', $2, $3, $4, 'apple_note', $5, $6, $7::jsonb, 'ready', now(), now())
       on conflict (source, source_ref) where source_ref is not null do update set
         title = excluded.title, transcript = excluded.transcript, content_sha256 = excluded.content_sha256,
         source_payload = excluded.source_payload, pipeline_status = 'ready', pipeline_error = null,
         pipeline_updated_at = now(), updated_at = now(), embed_attempts = 0, embed_error = null
       returning id, (xmax = 0) as inserted, workspace_id`,
      [decision?.workspaceId ?? row?.workspace_id ?? INBOX, occurredAt.toISOString(), title, paragraphs.join("\n\n"), input.source_ref, contentSha, JSON.stringify(payload)],
    );
    const id = Number(ins.rows[0].id);
    await db.query(`delete from segments where interaction_id = $1`, [id]);
    for (let i = 0; i < paragraphs.length; i += 200) {
      const slice = paragraphs.slice(i, i + 200);
      const params: unknown[] = [];
      const values = slice.map((t, j) => {
        params.push(id, i + j, t);
        const b = params.length - 3;
        return `($${b + 1}, $${b + 2}, 0, 0, null, $${b + 3})`;
      });
      await db.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ${values.join(", ")}`, params);
    }
    await db.query("commit");
    const inserted = ins.rows[0].inserted;
    const queued = inserted && decision?.review?.suggested ? await queueWorkspaceReview(deps.pool, id, decision) : false;
    await countItem(deps.pool, caller, input.run_id, "apple_note", inserted ? "created" : "updated");
    return { interaction_id: id, status: inserted ? "created" : "updated", workspace_id: ins.rows[0].workspace_id ?? INBOX, review_queued: queued };
  } catch (err) {
    await db.query("rollback").catch(() => {});
    await countItem(deps.pool, caller, input.run_id, "apple_note", "error", "internal_error");
    throw err;
  } finally {
    db.release();
  }
}

// -------------------------------------------------------------------- runs --

export async function startRun(pool: pg.Pool, caller: DeviceCaller, body: z.infer<typeof runStartSchema>): Promise<number> {
  const { rows } = await pool.query(`insert into import_runs (source, counts_in, counts_out) values ($1, $2::jsonb, '{}'::jsonb) returning id`, [
    runSource(caller),
    JSON.stringify({ token: `pat:${caller.tokenId}`, collector: body.collector ?? null, ...(body.counts_in ?? {}) }),
  ]);
  return Number(rows[0].id);
}

export async function finishRun(pool: pg.Pool, caller: DeviceCaller, id: number, body: z.infer<typeof runFinishSchema>): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `update import_runs set finished_at = now(),
            counts_in = counts_in || $3::jsonb,
            ok = coalesce($4, coalesce((counts_out->>'errors')::int, 0) = 0),
            counts_out = case when $5::text is null then counts_out else counts_out || jsonb_build_object('last_error', $5::text) end
      where id = $1 and counts_in->>'token' = $2 and finished_at is null
      returning counts_out`,
    [id, `pat:${caller.tokenId}`, JSON.stringify(body.counts_in ?? {}), body.ok ?? null, body.error ? body.error.slice(0, 300) : null],
  );
  return rows[0]?.counts_out ?? null;
}

type Outcome = "created" | "updated" | "unchanged" | "duplicate" | "empty" | "error";

/**
 * Counts one item into its batch's import_runs row (counts_out.<outcome>.<source>). An item sent
 * without a run (every Shortcut send) is its own one-item batch.
 */
async function countItem(pool: pg.Pool, caller: DeviceCaller, run: number | undefined, source: string, outcome: Outcome, errorCode?: string): Promise<void> {
  const bump = `jsonb_set(coalesce(counts_out, '{}'::jsonb), array[$2::text], coalesce(counts_out->$2, '{}'::jsonb) || jsonb_build_object($3::text, coalesce((counts_out->$2->>$3)::int, 0) + 1))`;
  const errs = outcome === "error" ? ` || jsonb_build_object('errors', coalesce((counts_out->>'errors')::int, 0) + 1, 'last_error', $4::text)` : "";
  const params = outcome === "error" ? [outcome, source, errorCode ?? "error"] : [outcome, source];
  if (run) {
    const r = await pool.query(`update import_runs set counts_out = ${bump}${errs} where id = $1 and counts_in->>'token' = $${params.length + 2} and finished_at is null`, [run, ...params, `pat:${caller.tokenId}`]);
    if (r.rowCount) return;
  }
  const ins = await pool.query(`insert into import_runs (source, counts_in, counts_out, finished_at, ok) values ($1, $2::jsonb, '{}'::jsonb, now(), $3) returning id`, [
    runSource(caller),
    JSON.stringify({ token: `pat:${caller.tokenId}`, items: 1 }),
    outcome !== "error",
  ]);
  await pool.query(`update import_runs set counts_out = ${bump}${errs} where id = $1`, [ins.rows[0].id, ...params]);
}

/**
 * Adds who was on a call to one the vault already has, when it came in without anyone (an iPhone
 * "Call Recording" note carries no contact; the collector finds the number in the Mac's call
 * history afterwards). Only fills an empty participant list, never replaces one, and clears
 * linked_at so the worker's link step matches the number and retitles the call.
 */
export async function updateDeviceParticipants(deps: DeviceDeps, input: z.infer<typeof participantsSchema>): Promise<{ interaction_id: number | null; status: "updated" | "unchanged" | "not_found" }> {
  const { rows } = await deps.pool.query(`select id, participants_raw from interactions where source = $1 and source_ref = $2`, [input.source, input.source_ref]);
  const row = rows[0];
  if (!row) return { interaction_id: null, status: "not_found" };
  const existing = Array.isArray(row.participants_raw) ? row.participants_raw : [];
  if (existing.length) return { interaction_id: Number(row.id), status: "unchanged" };
  const people = await identifyParticipants(deps.pool, input.participants_raw, deps.owner);
  if (!people.raw.length) return { interaction_id: Number(row.id), status: "unchanged" };
  await deps.pool.query(`update interactions set participants_raw = $2::jsonb, linked_at = null, updated_at = now() where id = $1`, [row.id, JSON.stringify(people.raw)]);
  return { interaction_id: Number(row.id), status: "updated" };
}
