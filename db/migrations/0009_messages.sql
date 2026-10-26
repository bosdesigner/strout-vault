-- relationship-engine v0.9: texts and email come into the vault (Jarvis step 4).
--
--   interactions      two new kinds: text_thread (one iMessage/SMS conversation per local day,
--                     America/Chicago, source 'imessage') and email_thread (one Gmail thread,
--                     source 'gmail'). Each message is a `segments` row, so the existing chunker,
--                     embedder, FTS and MCP tools work unchanged. Upserted by (source, source_ref)
--                     through the existing interactions_source_ref unique index.
--   workspaces        `personal` (family and personal threads) and `inbox` (threads whose
--                     workspace is unclear, or that would have gone to phalanx). Like phalanx,
--                     neither is implied by a "*" token scope: server/mcp/scope.ts.
--   api_tokens        `scopes`: what a personal access token may do. Existing tokens keep
--                     vault:read + vault:propose (the MCP server). A token whose scopes are only
--                     ingest:messages can POST /api/ingest/messages and nothing else: no MCP, no reads.
--   message_accounts  one row per connected Gmail account: the OAuth refresh token (AES-256-GCM,
--                     key in MESSAGES_ENCRYPTION_KEY), the Gmail historyId the incremental sync
--                     resumes from, and the last error. Never granted to the MCP roles.
--   review_queue      an index for the per-identifier new_party dedupe the ingest runs.
--
-- Additive and idempotent, safe to re-run. Nothing here is ever deleted by the app.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0009_messages.sql); the app never runs DDL.

alter table interactions drop constraint if exists interactions_kind_check;
alter table interactions add constraint interactions_kind_check
  check (kind in ('call', 'meeting', 'email', 'text', 'in_person', 'other', 'text_thread', 'email_thread'));

insert into workspaces (id, name, owner, notes) values
  ('personal', 'Personal', 'Ben Strout', 'Family and personal texts and email. Never included in a "*" token scope.'),
  ('inbox', 'Inbox', 'Ben Strout', 'Texts and email waiting to be filed under a workspace. Never included in a "*" token scope.')
on conflict (id) do nothing;

alter table api_tokens
  add column if not exists scopes text[] not null default '{vault:read,vault:propose}';

create table if not exists message_accounts (
  id                bigserial primary key,
  provider          text not null check (provider in ('gmail')),
  account_email     text not null,
  refresh_token_enc text not null,                 -- "v1:<iv>:<tag>:<ciphertext>" (base64url), AES-256-GCM
  scope             text,                          -- what Google granted; must be gmail.readonly only
  history_id        text,                          -- Gmail historyId the next incremental sync starts from
  status            text not null default 'active' check (status in ('active', 'disabled', 'error')),
  last_synced_at    timestamptz,
  last_error        text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, account_email)
);

create index if not exists review_queue_new_party_identifier
  on review_queue ((proposal -> 'evidence' ->> 'identifier')) where item_type = 'new_party';
create index if not exists interactions_message_kinds on interactions (occurred_at desc) where kind in ('text_thread', 'email_thread');
create index if not exists interactions_message_participants on interactions using gin (participants_raw jsonb_path_ops) where kind in ('text_thread', 'email_thread');

insert into schema_log (change, rationale)
select 'v0.9 messages: text_thread/email_thread kinds, personal + inbox workspaces, api_tokens.scopes, message_accounts',
       'iMessage/SMS (a collector on the Mac) and Gmail (read-only API) become interactions linked to parties and routed to workspaces, searchable through the existing embed/search/MCP path'
where not exists (select 1 from schema_log where change like 'v0.9 messages%');
