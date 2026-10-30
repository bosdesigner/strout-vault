import crypto from "node:crypto";
import type pg from "pg";
import type { StorageDriver } from "../storage/types.ts";
import { normalizePhone } from "../twilio/signature.ts";

export interface TrackedNumber {
  id: number;
  workspaceId: string | null;
  membershipId: number | null;
  partyId: number | null;
  phoneNumber: string;
  forwardTo: string;
  recordingNotice: string | null;
  status: string;
}

export const DEFAULT_NOTICE = "This call may be recorded for quality and record keeping. Please hold while we connect you.";

export async function findTrackedNumber(pool: pg.Pool, phone: string | null | undefined): Promise<TrackedNumber | null> {
  const n = normalizePhone(phone);
  if (!n) return null;
  const { rows } = await pool.query(
    `select id, workspace_id, membership_id, party_id, phone_number, forward_to, recording_notice, status from tracked_numbers where phone_number = $1`,
    [n],
  );
  const r = rows[0];
  return r
    ? { id: r.id, workspaceId: r.workspace_id, membershipId: r.membership_id, partyId: r.party_id, phoneNumber: r.phone_number, forwardTo: r.forward_to, recordingNotice: r.recording_notice, status: r.status }
    : null;
}

/** Match a caller id against parties.phones (last ten digits, so formatting differences do not matter). */
export async function matchCallerParty(pool: pg.Pool, from: string | null | undefined): Promise<number | null> {
  const n = normalizePhone(from);
  if (!n || n.replace(/\D/g, "").length < 7) return null;
  const last10 = n.replace(/\D/g, "").slice(-10);
  const { rows } = await pool.query(
    `select p.id from parties p, unnest(p.phones) ph
     where right(regexp_replace(ph, '\\D', '', 'g'), 10) = $1
     order by (p.kind = 'person') desc, p.id limit 1`,
    [last10],
  );
  return rows[0]?.id ?? null;
}

export interface IncomingCall {
  callSid: string;
  from: string | null;
  to: string | null;
  raw: Record<string, string>;
}

/** First webhook for a call: record it and answer with who to forward to. */
export async function recordIncomingCall(pool: pg.Pool, tn: TrackedNumber, call: IncomingCall): Promise<{ callId: number; callerPartyId: number | null }> {
  const callerPartyId = await matchCallerParty(pool, call.from);
  const { rows } = await pool.query(
    `insert into calls (tracked_number_id, call_sid, direction, from_number, to_number, caller_party_id, started_at, status, raw)
     values ($1, $2, 'inbound', $3, $4, $5, now(), 'ringing', $6)
     on conflict (call_sid) do update set status = coalesce(calls.status, 'ringing'), updated_at = now()
     returning id`,
    [tn.id, call.callSid, normalizePhone(call.from), normalizePhone(call.to), callerPartyId, JSON.stringify(call.raw)],
  );
  return { callId: rows[0].id, callerPartyId };
}

export async function recordCallStatus(pool: pg.Pool, callSid: string, status: string | null, durationSec: number | null, raw: Record<string, string>): Promise<boolean> {
  const res = await pool.query(
    `update calls set status = coalesce($2, status), duration_sec = coalesce($3, duration_sec),
            ended_at = case when $2 in ('completed','no-answer','busy','failed','canceled') then now() else ended_at end,
            raw = coalesce(raw, '{}'::jsonb) || $4::jsonb, updated_at = now()
     where call_sid = $1`,
    [callSid, status, durationSec, JSON.stringify(raw)],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface RecordingEvent {
  callSid: string;
  recordingSid: string;
  recordingUrl: string;
  durationSec: number | null;
}

export interface IngestDeps {
  pool: pg.Pool;
  storage: StorageDriver;
  fetchImpl: typeof fetch;
  twilio: { accountSid: string; authToken: string };
}

/**
 * Copies a finished Twilio recording into the vault: fetch the audio once,
 * put it in storage under calls/<yyyy>/<mm>/<CallSid>.mp3, then in one
 * transaction create the interaction (source contractor_call, pipeline
 * queued), its media row, transcribe + extract jobs, and participants
 * (the contractor who owns the number, plus the caller when caller id matched a
 * person). Idempotent per call: a second callback for the same call is a no-op.
 */
export async function ingestRecording(deps: IngestDeps, ev: RecordingEvent): Promise<{ interactionId: number; mediaId: number; skipped?: boolean }> {
  const { pool, storage } = deps;
  const { rows } = await pool.query(
    `select c.*, tn.workspace_id as tn_workspace_id, tn.party_id as tn_party_id, tn.phone_number as tn_phone
     from calls c left join tracked_numbers tn on tn.id = c.tracked_number_id where c.call_sid = $1`,
    [ev.callSid],
  );
  const call = rows[0];
  if (!call) throw new Error(`unknown call ${ev.callSid}`);
  if (call.interaction_id && call.media_id) return { interactionId: call.interaction_id, mediaId: call.media_id, skipped: true };

  await pool.query(`update calls set recording_sid = $2, recording_url = $3, recording_status = 'pending', duration_sec = coalesce($4, duration_sec), updated_at = now() where id = $1`, [
    call.id,
    ev.recordingSid,
    ev.recordingUrl,
    ev.durationSec,
  ]);

  // Twilio serves recordings at <RecordingUrl>.mp3 with HTTP basic auth.
  const url = ev.recordingUrl.endsWith(".mp3") || ev.recordingUrl.endsWith(".wav") ? ev.recordingUrl : `${ev.recordingUrl}.mp3`;
  const auth = Buffer.from(`${deps.twilio.accountSid}:${deps.twilio.authToken}`).toString("base64");
  let body: Buffer;
  try {
    const res = await deps.fetchImpl(url, { headers: { authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`Twilio returned ${res.status} for the recording`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    await pool.query(`update calls set recording_status = 'failed', recording_error = $2, updated_at = now() where id = $1`, [call.id, err instanceof Error ? err.message : String(err)]);
    throw err;
  }
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const started: Date = call.started_at ? new Date(call.started_at) : new Date();
  const key = `calls/${started.getUTCFullYear()}/${String(started.getUTCMonth() + 1).padStart(2, "0")}/${ev.callSid}.mp3`;
  await storage.putObject({ key, body, contentType: "audio/mpeg" });

  const callerName = call.caller_party_id ? (await pool.query(`select name from parties where id = $1`, [call.caller_party_id])).rows[0]?.name : null;
  const title = `Call with ${callerName ?? call.from_number ?? "unknown caller"}`;
  const durationSec = ev.durationSec ?? call.duration_sec ?? null;
  const target = storage.uploadTarget;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const inter = await client.query(
      `insert into interactions (workspace_id, kind, occurred_at, title, source, source_ref, duration_sec, content_sha256, participants_raw, pipeline_status, pipeline_updated_at, updated_at)
       values ($1, 'call', $2, $3, 'contractor_call', $4, $5, $6, $7, 'queued', now(), now())
       on conflict (source, source_ref) where source_ref is not null do update set updated_at = now()
       returning id`,
      [call.tn_workspace_id, started.toISOString(), title, ev.callSid, durationSec, sha256, JSON.stringify({ from: call.from_number, to: call.to_number, tracked_number: call.tn_phone })],
    );
    const interactionId: number = inter.rows[0].id;
    const med = await client.query(
      `insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, kind, role, mime_type, bytes, bytes_expected, sha256, status, recorded_at, uploaded_by, original_filename, verified_at, duration_sec)
       values ($1, $2, 'contractor_call', $3, $4, $5, 'audio', 'original', 'audio/mpeg', $6, $6, $7, 'verified', $8, $9, $10, now(), $11)
       on conflict (storage, coalesce(bucket, ''), storage_key) do update set bytes = excluded.bytes, sha256 = excluded.sha256
       returning id`,
      [interactionId, call.tn_workspace_id, target.storage, target.bucket, key, body.length, sha256, started.toISOString(), call.tn_party_id, `${ev.callSid}.mp3`, durationSec],
    );
    const mediaId: number = med.rows[0].id;
    await client.query(`update interactions set media_id = $1 where id = $2`, [mediaId, interactionId]);
    await client.query(`insert into jobs (media_id, stage, status) values ($1, 'transcribe', 'pending') on conflict (media_id, stage) do nothing`, [mediaId]);
    const participants = [call.tn_party_id, call.caller_party_id].filter((x): x is number => !!x);
    if (participants.length) {
      await client.query(`insert into interaction_participants (interaction_id, party_id) select $1, unnest($2::bigint[]) on conflict do nothing`, [interactionId, participants]);
    }
    await client.query(`update calls set media_id = $2, interaction_id = $3, recording_status = 'stored', recording_error = null, updated_at = now() where id = $1`, [call.id, mediaId, interactionId]);
    await client.query("commit");
    return { interactionId, mediaId };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    await pool.query(`update calls set recording_status = 'failed', recording_error = $2, updated_at = now() where id = $1`, [call.id, err instanceof Error ? err.message : String(err)]);
    throw err;
  } finally {
    client.release();
  }
}
