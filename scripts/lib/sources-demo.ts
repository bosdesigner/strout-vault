// Fake ingest history for the Sources panel: enough rows in worker_runs, import_runs,
// message_accounts, api_tokens and interactions that every status type shows (live, configured but
// never run, not configured, erroring, plus a stale-collector warning). Used by
// tests/api/sources.test.ts and `npm run sources:demo` (the screenshot). Local databases only.
import type pg from "pg";

const DAY = 86400_000;

export async function seedSourcesDemo(pool: pg.Pool, now = new Date()): Promise<void> {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const h = 3600_000;

  // Zoom: an hourly worker that synced 40 minutes ago, with recordings over the last month.
  const config = { zoomConfigured: true, groqConfigured: true, groqBudgetUsd: 10, groqModel: "whisper-large-v3-turbo", transcribePrefer: "zoom", archiveStorage: "b2", archiveBucket: "anotherstory-meeting-vault", overlapMonths: 3, meetConfigured: true, gmailConfigured: true };
  const zoomSummary = { config, zoom: { configured: true, windows: 4, recordingsSeen: 3, recordingsNew: 1, filesQueued: 3, filesVerified: 3, filesStable: 0, filesFailed: 0, bytes: 412_000_000, cursor: null, errors: [] }, durationSec: 42, errors: [] };
  await pool.query(`insert into worker_runs (started_at, finished_at, ok, trigger, host, summary) values ($1, $2, true, 'schedule', 'demo', $3)`, [at(41 * 60_000), at(40 * 60_000), JSON.stringify(zoomSummary)]);

  // Gmail: three accounts. Live, connected but never synced, and one whose grant was revoked.
  const enc = "v1:demo:demo:demo";
  await pool.query(
    `insert into message_accounts (provider, account_email, refresh_token_enc, scope, history_id, status, last_synced_at, last_error, updated_at) values
       ('gmail', 'ben@anotherstory.example', $1, 'gmail.readonly', '9001', 'active', $2, null, $2),
       ('gmail', 'ben@stroutarch.example', $1, 'gmail.readonly', null, 'active', null, null, $3),
       ('gmail', 'ben.strout@gmail.example', $1, 'gmail.readonly', '777', 'error', $4, 'token refresh failed: invalid_grant', $5)
     on conflict (provider, account_email) do nothing`,
    [enc, at(6 * 60_000), at(2 * DAY), at(3 * DAY), at(2 * h)],
  );
  // Google Meet: one account with recordings, one whose plan has none.
  await pool.query(
    `insert into message_accounts (provider, account_email, refresh_token_enc, scope, status, last_synced_at, capability, detail, updated_at) values
       ('meet', 'ben@anotherstory.example', $1, 'drive.meet.readonly', 'active', $2, 'recordings', '{"recordings_seen": 4}', $2),
       ('meet', 'ben.strout@gmail.example', $1, 'drive.meet.readonly', 'active', $2, 'none_found', '{}', $2)
     on conflict (provider, account_email) do nothing`,
    [enc, at(38 * 60_000)],
  );

  // Collectors' tokens: iMessage and the Mac media collector; the Shortcut token exists but has never sent.
  for (const [name, scope, purpose, hash] of [
    ["iMessage collector", "ingest:messages", "imessage", "demo-imessage"],
    ["Mac media collector", "ingest:device", "mac_media", "demo-mac"],
    ["iPhone Shortcut", "ingest:device", "ios_shortcut", "demo-shortcut"],
  ] as const) {
    await pool.query(
      `insert into api_tokens (name, token_hash, token_prefix, workspace_scope, scopes, created_by, purpose) values ($1, $2, 'svt_demo', '[]'::jsonb, $3, 'demo', $4) on conflict (token_hash) do nothing`,
      [name, hash, [scope], purpose],
    );
  }
  // iMessage: last batch three hours ago (a quiet evening, or the Mac is asleep): live, with a warning.
  await pool.query(`insert into import_runs (source, counts_in, counts_out, started_at, finished_at, ok) values ('imessage', '{"threads": 4, "messages": 31}', '{"created": 2, "updated": 2, "errors": 0}', $1, $1, true)`, [at(3 * h)]);
  // Mac media collector: checked in four minutes ago; a call recording failed in that batch.
  await pool.query(`insert into import_runs (source, counts_in, counts_out, started_at, finished_at, ok) values ('apple_media', '{"token": "pat:demo"}', '{"created": {"voice_memo": 2, "apple_note": 5}}', $1, $1, true)`, [at(14 * 60_000)]);
  await pool.query(
    `insert into import_runs (source, counts_in, counts_out, started_at, finished_at, ok) values ('apple_media', '{"token": "pat:demo"}', '{"created": {"voice_memo": 1}, "error": {"iphone_call": 1}, "errors": 1, "last_error": "object_missing"}', $1, $1, false)`,
    [at(4 * 60_000)],
  );

  // Items, as each ingest point wrote them, spread over the last month.
  const items: Array<[string, string, string, string | null, number, Record<string, unknown> | null]> = [];
  const add = (source: string, kind: string, ref: string | null, ago: number, payload: Record<string, unknown> | null = null) => items.push([source, kind, `Demo ${source} ${items.length + 1}`, ref, ago, payload]);
  for (let i = 0; i < 9; i++) add("zoom", "meeting", `demo-zoom-${i}`, i * 3 * DAY + 2 * h);
  for (let i = 0; i < 6; i++) add("gmail", "email_thread", `gmail:ben@anotherstory.example:demo${i}`, i * 0.4 * DAY + h);
  for (let i = 0; i < 2; i++) add("gmail", "email_thread", `gmail:ben.strout@gmail.example:demo${i}`, 4 * DAY + i * DAY);
  for (let i = 0; i < 5; i++) add("imessage", "text_thread", `imessage:demo:${i}`, i * DAY + 3 * h);
  for (let i = 0; i < 4; i++) add("voice_memo", "recording", `voice_memo:demo-${i}`, i * 2 * DAY + h, { via: "mac_collector" });
  for (let i = 0; i < 3; i++) add("iphone_call", "call", `notes:demo-${i}:att`, i * 5 * DAY + 5 * h, { via: "mac_collector" });
  for (let i = 0; i < 12; i++) add("apple_note", "note", `apple_note:demo-${i}`, i * 2 * DAY + 30 * 60_000, { via: "mac_collector" });
  for (let i = 0; i < 4; i++) add("meet", "meeting", `meet:ben@anotherstory.example:demo${i}`, i * 6 * DAY + 4 * h);
  for (const [source, kind, title, ref, ago, payload] of items) {
    await pool.query(
      `insert into interactions (workspace_id, kind, title, source, source_ref, source_payload, occurred_at, created_at, pipeline_status) values ('inbox', $1, $2, $3, $4, $5::jsonb, $6, $6, 'ready')
       on conflict (source, source_ref) where source_ref is not null do nothing`,
      [kind, title, source, ref, payload ? JSON.stringify(payload) : null, at(ago)],
    );
  }
}
