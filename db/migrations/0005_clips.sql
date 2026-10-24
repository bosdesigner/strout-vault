-- relationship-engine v0.5: clip scouting and rendering move into the worker (Phase 5).
--
-- The worker scouts new transcripts with Claude (clip_candidates, status 'new'),
-- the owner approves in the app, and the worker renders approved candidates
-- into 9:16 captioned MP4s in R2 (media role 'clip' + clips rows). These
-- columns carry the render bookkeeping. Additive only, safe to re-run.

alter table clip_candidates
  add column if not exists approved_at     timestamptz,
  add column if not exists rendered_at     timestamptz,
  add column if not exists render_attempts int not null default 0,
  add column if not exists render_error    text;

-- Why a recording was skipped by the scout (no transcript, over budget, API error).
alter table interactions
  add column if not exists scout_error text;

create index if not exists clip_candidates_interaction on clip_candidates (interaction_id, status);

insert into schema_log (change, rationale)
select 'v0.5 clips: clip_candidates render bookkeeping, interactions.scout_error',
       'Clip scouting (Claude) and rendering (ffmpeg) run in the hourly worker; approved candidates become downloadable clips in R2'
where not exists (select 1 from schema_log where change like 'v0.5 clips%');
