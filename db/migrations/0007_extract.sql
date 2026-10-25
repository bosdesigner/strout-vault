-- relationship-engine v0.7: the extraction step (Jarvis step 2).
--
--   interactions   extraction bookkeeping (extracted_at, extract_model, extract_error), the
--                  same pattern as scouted_at / scout_error: the worker reads each filed
--                  recording once with Claude and queues what it finds in review_queue.
--   facts          source_review_id: the review item a fact was approved from, so every
--                  fact traces back to its proposal (and through it to the moment).
--   review_queue   an index for the per-recording duplicate check the extractor runs
--                  before queueing, and for the Review page's per-recording lookups.
--
-- Additive and idempotent, safe to re-run. No new grants: mcp_reader already reads facts
-- and review_queue, mcp_proposer already inserts into review_queue.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0007_extract.sql); the app never runs DDL.

alter table interactions
  add column if not exists extracted_at  timestamptz,
  add column if not exists extract_model text,
  add column if not exists extract_error text;
create index if not exists interactions_extract_pending on interactions (occurred_at desc) where extracted_at is null and workspace_id is not null;

alter table facts
  add column if not exists source_review_id bigint references review_queue(id) on delete set null;
create index if not exists facts_interaction on facts (interaction_id);

create index if not exists review_queue_interaction on review_queue (interaction_id, item_type, status);

insert into schema_log (change, rationale)
select 'v0.7 extract: interactions extraction bookkeeping, facts.source_review_id, review_queue_interaction index',
       'The worker reads filed recordings with Claude and queues commitments, decisions, prices, speaker matches and project links for review; approving a proposal applies it'
where not exists (select 1 from schema_log where change like 'v0.7 extract%');
