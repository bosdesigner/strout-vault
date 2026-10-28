-- relationship-engine v0.12: follow-through (Jarvis step 5 C, docs/FOLLOW-THROUGH.md).
--
--   facts          closed_at / closed_by_interaction_id: when a commitment or follow-up was marked
--                  done (or dropped) on Review, and the conversation that showed it.
--                  followup_checked_at: when the worker last asked Claude whether the commitment
--                  was kept, so the same evidence is never paid for twice.
--   review_queue   an index on proposal->>'key', the follow-through step's duplicate check (a reply,
--                  nudge or done-check it already queued, open or decided, never comes back).
--
-- The new review item types (fact_status, reply_needed, nudge) need no DDL: item_type is free text.
-- Additive and idempotent, safe to re-run. No new grants: mcp_reader already reads facts.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0012_followthrough.sql); the app never runs DDL.

alter table facts
  add column if not exists closed_at                timestamptz,
  add column if not exists closed_by_interaction_id bigint references interactions(id) on delete set null,
  add column if not exists followup_checked_at      timestamptz;

create index if not exists review_queue_followthrough_key on review_queue ((proposal->>'key')) where proposal->>'source' = 'followthrough';

insert into schema_log (change, rationale)
select 'v0.12 followthrough: facts.closed_at, closed_by_interaction_id, followup_checked_at; review_queue key index',
       'The worker notices commitments that were kept, overdue or stale, messages waiting on a reply and contacts gone quiet, and queues them on Review with a drafted reply'
where not exists (select 1 from schema_log where change like 'v0.12 followthrough%');
