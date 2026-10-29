-- relationship-engine v0.11: extraction reads texts, email and confidently-filed unfiled recordings
-- (Jarvis step 5 B, docs/FOLLOW-THROUGH.md).
--
--   interactions   extracted_through_idx: the last segment (message) the extractor read. Text and
--                  email threads grow after they are first read; the worker reads a thread again
--                  when it has segments past this index, and sends only those (the earlier ones go
--                  along as context). Null for recordings, which are read once.
--
-- Additive and idempotent, safe to re-run. No new grants.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0011_extract_threads.sql); the app never runs DDL.

alter table interactions
  add column if not exists extracted_through_idx int;

insert into schema_log (change, rationale)
select 'v0.11 extract threads: interactions.extracted_through_idx',
       'The extractor reads text and email threads (again when they gain messages, sending only the new ones) and unfiled recordings the workspace classifier files confidently'
where not exists (select 1 from schema_log where change like 'v0.11 extract threads%');
