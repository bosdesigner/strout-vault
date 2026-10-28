-- relationship-engine v0.11: TikTok and Instagram direct messages (docs/SOCIAL_DMS.md).
--
--   parties           `handles`: social accounts a person is known by, stored as
--                     "<platform>:<username>" in lowercase without the @ ("tiktok:hemakesbigmoves",
--                     "instagram:kevin.btg"). Matched exactly like emails and phones: a DM from a
--                     handle on this list is that person's, and an unknown handle is queued for
--                     review (new_party), never created.
--   interactions      no change: a DM conversation is kind 'text_thread' with source 'tiktok' or
--                     'instagram', one row per conversation per local day, like iMessage.
--   message_accounts  provider 'instagram' (an Instagram professional account connected with
--                     instagram_business_basic + instagram_business_manage_messages; the long-lived
--                     token, AES-256-GCM, in refresh_token_enc; account_email holds the username) and
--                     `token_expires_at`, so the worker refreshes it before its 60 days run out.
--   api_tokens        purpose 'social_dm': an ingest:messages token made for the TikTok DM
--                     collector on the Mac. It can POST /api/ingest/social and nothing else.
--
-- Additive and idempotent, safe to re-run. Nothing here is ever deleted by the app.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0011_social_dms.sql) after 0010;
-- the app never runs DDL.

alter table parties add column if not exists handles text[] not null default '{}';
create index if not exists parties_handles on parties using gin (handles);

alter table message_accounts drop constraint if exists message_accounts_provider_check;
alter table message_accounts add constraint message_accounts_provider_check check (provider in ('gmail', 'meet', 'instagram'));
alter table message_accounts add column if not exists token_expires_at timestamptz;

insert into schema_log (change, rationale)
select 'v0.11 social dms: parties.handles, message_accounts instagram, api_tokens purpose social_dm',
       'TikTok DMs (a browser collector on the Mac) and Instagram DMs (the official Instagram API) become text_thread interactions matched to people by handle and routed like texts'
where not exists (select 1 from schema_log where change like 'v0.11 social dms%');
