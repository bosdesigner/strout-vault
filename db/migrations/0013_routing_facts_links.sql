-- relationship-engine v0.13: routing, extraction to facts, people linking (Jarvis Phase 1 v2,
-- docs/phase1-map.md and docs/phase1-verification.md).
--
--   interactions   classified_at / classify_*: the content classifier (server/workspaces/route.ts,
--                  worker step `classify`) reads every new interaction once and files it from its
--                  participants, the Gmail account, phalanx terms and a Claude pass over the first
--                  ~2,000 characters. The columns are the queue: null classified_at = not read yet.
--                  linked_at / link_error: the people-linking step (server/people/link.ts, worker step
--                  `link`) has looked for this interaction's participants.
--   facts          'task' joins the kinds (the extractor's types are commitment, task, follow_up,
--                  decision and amount; follow_up is stored as the existing 'followup', amount as
--                  'price'). quote (verbatim), message_idx (the message a thread fact came from),
--                  origin (extract | review | backfill), and a trigram index for the cross-source
--                  duplicate check.
--   fact_sources   every conversation a fact was said in. The same promise made on a call and again in
--                  a text is one fact with two sources, not two facts.
--   interactions   kind dm_thread (Phase 2 hook: TikTok / Instagram DMs through a source adapter).
--   parties        merged_into: a duplicate party merged into another keeps its row (and its id in old
--                  review items) and points at the survivor.
--
-- Additive and idempotent, safe to re-run. Apply by hand after 0012
-- (psql "$DATABASE_URL" -f db/migrations/0013_routing_facts_links.sql); the app never runs DDL.

-- dm_thread: a social-media DM conversation (TikTok, Instagram), Phase 2. Same shape as text_thread.
alter table interactions drop constraint if exists interactions_kind_check;
alter table interactions add constraint interactions_kind_check
  check (kind in ('call', 'meeting', 'email', 'text', 'in_person', 'other', 'text_thread', 'email_thread', 'recording', 'note', 'dm_thread'));

alter table interactions
  add column if not exists classified_at       timestamptz,
  add column if not exists classify_model      text,
  add column if not exists classify_confidence real,
  add column if not exists classify_evidence   jsonb,
  add column if not exists classify_error      text,
  add column if not exists linked_at           timestamptz,
  add column if not exists link_error          text;
create index if not exists interactions_classify_pending on interactions (occurred_at desc nulls last) where classified_at is null;
create index if not exists interactions_link_pending on interactions (occurred_at desc nulls last) where linked_at is null;

alter table facts drop constraint if exists facts_kind_check;
alter table facts add constraint facts_kind_check
  check (kind in ('commitment', 'task', 'decision', 'price', 'followup', 'issue', 'preference', 'other'));
alter table facts
  add column if not exists quote       text,
  add column if not exists message_idx int,
  add column if not exists origin      text;
create index if not exists facts_text_trgm on facts using gin (text gin_trgm_ops);
create index if not exists facts_open on facts (status, due_date) where status = 'open';

create table if not exists fact_sources (
  fact_id         bigint not null references facts(id) on delete cascade,
  interaction_id  bigint not null references interactions(id) on delete cascade,
  quote           text,
  quote_start_sec int,
  message_idx     int,
  confidence      real,
  created_at      timestamptz not null default now(),
  primary key (fact_id, interaction_id)
);
create index if not exists fact_sources_interaction on fact_sources (interaction_id);

alter table parties add column if not exists merged_into bigint references parties(id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    grant select on fact_sources to mcp_reader;
  end if;
end $$;

insert into schema_log (change, rationale)
select 'v0.13 routing + facts + links: interactions classify/link bookkeeping, facts task kind + quote + origin, fact_sources, parties.merged_into',
       'Every interaction is filed from its content (phalanx guarded), extraction writes open facts directly with every source linked, and Zoom/calls get their people'
where not exists (select 1 from schema_log where change like 'v0.13 routing%');
