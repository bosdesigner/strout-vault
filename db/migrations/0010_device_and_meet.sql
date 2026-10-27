-- relationship-engine v0.10: every remaining ingest point (docs/INGEST.md).
--
--   interactions      two new kinds: recording (a Voice Memo, source 'voice_memo') and note (an
--                     Apple Note, source 'apple_note', text only, no media). iPhone call recordings
--                     keep kind 'call' / source 'iphone_call'; Google Meet recordings are kind
--                     'meeting' / source 'meet' (both already allowed). Every device item is upserted
--                     by (source, source_ref) through the existing interactions_source_ref index.
--   media             a unique index on sha256 for the files the device ingest stored
--                     (uploads/device/...): the same file sent twice (Mac collector, then the iPhone
--                     Shortcut, or the reverse) is one row. Older media rows are not covered, because
--                     the meeting-vault import keeps one row per stored copy of the same file; the
--                     ingest checks every media row by sha256 in code before writing.
--   api_tokens        `purpose`: which collector a token was made for (imessage, mac_media,
--                     ios_shortcut), so the Sources view can tell "configured but never run" apart
--                     from "not configured". A token whose scopes are only ingest:device may call
--                     /api/ingest/device/* and nothing else: no reads, no MCP.
--   message_accounts  provider 'meet' (a Google account connected with drive.meet.readonly only,
--                     plus calendar.events.readonly when asked for), its own encrypted refresh token
--                     (Gmail's grant stays gmail.readonly only), and `capability` / `detail` so the
--                     worker can record "this account has no Meet recordings" once and move on.
--
-- Additive and idempotent, safe to re-run. Nothing here is ever deleted by the app.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0010_device_and_meet.sql) after 0009;
-- the app never runs DDL.

alter table interactions drop constraint if exists interactions_kind_check;
alter table interactions add constraint interactions_kind_check
  check (kind in ('call', 'meeting', 'email', 'text', 'in_person', 'other', 'text_thread', 'email_thread', 'recording', 'note'));

create unique index if not exists media_device_sha
  on media (sha256) where storage_key like 'uploads/device/%' and role = 'original';

alter table api_tokens add column if not exists purpose text;

alter table message_accounts drop constraint if exists message_accounts_provider_check;
alter table message_accounts add constraint message_accounts_provider_check check (provider in ('gmail', 'meet'));
alter table message_accounts add column if not exists capability text;   -- meet: null (not checked yet) | recordings | none_found
alter table message_accounts add column if not exists detail jsonb;      -- meet: files seen, last listing time; counts only

create index if not exists interactions_device_kinds on interactions (occurred_at desc) where source in ('voice_memo', 'apple_note', 'iphone_call', 'meet');
create index if not exists import_runs_source_started on import_runs (source, started_at desc);

insert into schema_log (change, rationale)
select 'v0.10 device + meet: recording/note kinds, media_device_sha, api_tokens.purpose, message_accounts meet',
       'Voice Memos, iPhone call recordings and Apple Notes (Mac collector, iPhone Shortcut) and Google Meet recordings (Drive, read-only) come into the vault through the existing upload, transcription and embedding path'
where not exists (select 1 from schema_log where change like 'v0.10 device%');
