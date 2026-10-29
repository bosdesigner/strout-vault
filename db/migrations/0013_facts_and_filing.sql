-- relationship-engine v0.13: facts written by the extractor, and Zoom / call filing and linking
-- (Phase 1 build, docs/phase1-verification.md).
--
--   facts             kind 'task' (commitment / task / followup / decision / price ...); the verbatim
--                     quote, the message index (texts and email), the relative date the due date was
--                     resolved from, where the fact came from (origin), a dedupe key, updated_at.
--   fact_sources      every moment a fact was said: the same promise in an email and a later call is
--                     one fact with two sources.
--   interactions      facts_status: where extraction stands for this interaction (null = not read yet,
--                     done | waiting | failed | skipped), separate from pipeline_status so a budget
--                     that runs out never hides a transcript. participants_resolved_at: when the
--                     participant resolver last ran on it. filed_by: the filing rule or routing that
--                     set workspace_id automatically (null = a person filed it, or it is unfiled).
--   interaction_participants
--                     resolved_by: how the resolver found the person (zoom_api, calendar, title,
--                     transcript, lead), null for hand-made or approved links. Lets a bad mapping be
--                     reverted as a set.
--
-- Additive and idempotent, safe to re-run. The app never runs DDL; apply by hand after 0012:
--   psql "$DATABASE_URL" -f db/migrations/0013_facts_and_filing.sql

alter table facts drop constraint if exists facts_kind_check;
alter table facts add constraint facts_kind_check
  check (kind in ('commitment', 'task', 'decision', 'price', 'followup', 'issue', 'preference', 'other'));

alter table facts
  add column if not exists quote         text,
  add column if not exists message_index int,
  add column if not exists due_text      text,
  add column if not exists origin        text,
  add column if not exists dedupe_key    text,
  add column if not exists updated_at    timestamptz default now();
create index if not exists facts_open_workspace on facts (workspace_id, due_date) where coalesce(status, 'open') = 'open';
create index if not exists facts_dedupe on facts (workspace_id, dedupe_key) where dedupe_key is not null;

create table if not exists fact_sources (
  id              bigserial primary key,
  fact_id         bigint not null references facts(id) on delete cascade,
  interaction_id  bigint not null references interactions(id) on delete cascade,
  quote           text,
  quote_start_sec int,
  message_index   int,
  created_at      timestamptz default now()
);
create unique index if not exists fact_sources_moment on fact_sources (fact_id, interaction_id, coalesce(quote_start_sec, -1));
create index if not exists fact_sources_interaction on fact_sources (interaction_id);

alter table interactions
  add column if not exists facts_status             text,
  add column if not exists participants_resolved_at timestamptz,
  add column if not exists filed_by                 text;
alter table interactions drop constraint if exists interactions_facts_status_check;
alter table interactions add constraint interactions_facts_status_check
  check (facts_status is null or facts_status in ('done', 'waiting', 'failed', 'skipped'));
create index if not exists interactions_resolve_pending on interactions (occurred_at desc)
  where participants_resolved_at is null and source in ('zoom', 'meet', 'iphone_call');

alter table interaction_participants add column if not exists resolved_by text;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    grant select on fact_sources to mcp_reader;
  else
    raise notice 'role mcp_reader does not exist: grants skipped (create it, then re-apply this file)';
  end if;
end $$;

insert into schema_log (change, rationale)
select 'v0.13 facts + filing: facts.kind task, quote/message_index/due_text/origin/dedupe_key, fact_sources, interactions.facts_status/participants_resolved_at/filed_by, interaction_participants.resolved_by',
       'The extractor writes open facts directly with their source quote and dedupes repeats across conversations; Zoom recordings and iPhone calls are filed by title rules and linked to the people on them'
where not exists (select 1 from schema_log where change like 'v0.13 facts%');
