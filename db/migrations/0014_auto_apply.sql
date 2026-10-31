-- relationship-engine v0.14: context-aware auto-approval of proposals (docs/AUTO-APPLY.md).
--
--   review_queue   decided_by: who decided an item — 'owner' (the Review page), 'auto' (the
--                  auto-apply rules), 'undo' (an auto-apply Ben reversed). route: the rules'
--                  verdict for the item ({auto, rule, reasons, quote, confidence}), stored for
--                  queued items too so the Review page can say why something waited.
--   auto_applies   one row per auto-applied proposal: what changed, the rule that allowed it,
--                  the source quote, and the undo steps. Undo replays `undo` in reverse and
--                  marks the row undone (and its review item rejected); nothing is deleted here.
--
-- Additive and idempotent, safe to re-run. Apply by hand after 0013
-- (psql "$DATABASE_URL" -f db/migrations/0014_auto_apply.sql); the app never runs DDL.
-- Until it is applied, every proposal queues exactly as before (the rules answer
-- "auto-apply-unavailable").

alter table review_queue
  add column if not exists decided_by text,
  add column if not exists route      jsonb;

create table if not exists auto_applies (
  id                    bigserial primary key,
  review_id             bigint not null unique references review_queue(id),
  item_type             text not null,
  rule                  text not null,
  source_interaction_id bigint references interactions(id) on delete set null,
  source_quote          text,
  confidence            real,
  applied               text[] not null default '{}',     -- human-readable: "parties #812", "parties #5 (phones +1)"
  undo                  jsonb not null default '[]'::jsonb, -- the steps that reverse it, replayed last-first
  actor                 text,                              -- "mcp:<token label>", "extract", "reevaluate"
  created_at            timestamptz not null default now(),
  undone_at             timestamptz,
  undone_by             text
);
create index if not exists auto_applies_created on auto_applies (created_at desc);

-- The MCP reader may see the log (get_* tools never expose it today; this keeps the grant list honest).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    grant select on auto_applies to mcp_reader;
  end if;
end $$;

insert into schema_log (change, rationale)
select 'v0.14 auto-apply: review_queue.decided_by + route, auto_applies',
       'Additive proposals backed by their source (verbatim values or a quote) apply on arrival; inferences, edits, duplicates and low confidence still queue. Every auto-apply is logged with its rule, quote and a one-click undo.'
where not exists (select 1 from schema_log where change like 'v0.14 auto-apply%');
