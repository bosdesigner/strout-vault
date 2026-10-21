-- relationship-engine v0.2: meeting-vault recordings move into Postgres.
--
-- Mapping from the SQLite manifest:
--   meetings        -> interactions   (one row per recording session)
--   files + archive -> media          (one row per stored copy: zoom-hosted,
--                                      local path, or cloud bucket object)
--   transcripts     -> transcripts
--   segments + FTS5 -> segments       (Postgres full-text via generated tsvector)
--   clip_candidates -> clip_candidates
--   clips           -> clips
--   runs, inbox_seen, kv -> not migrated (machine-local bookkeeping)
--
-- Additive only. Every legacy id is kept (legacy_*) so the import is
-- idempotent and any row can be traced back to the manifest it came from.

-- interactions: a recording is an interaction -----------------------------
alter table interactions
  add column if not exists vault_id          text unique,
  add column if not exists source            text,
  add column if not exists source_ref        text,
  add column if not exists legacy_meeting_id bigint,
  add column if not exists original_filename text,
  add column if not exists content_sha256    text,
  add column if not exists tags              text[] not null default '{}',
  add column if not exists duration_sec      real,
  add column if not exists host_email        text,
  add column if not exists participants_raw  jsonb,
  add column if not exists source_payload    jsonb,
  add column if not exists pipeline_status   text,
  add column if not exists pipeline_error    text,
  add column if not exists pipeline_updated_at timestamptz,
  add column if not exists scouted_at        timestamptz,
  add column if not exists updated_at        timestamptz default now();

create unique index if not exists interactions_source_ref
  on interactions (source, source_ref) where source_ref is not null;
create index if not exists interactions_occurred on interactions (occurred_at desc);
create index if not exists interactions_sha on interactions (content_sha256);
create index if not exists interactions_pipeline on interactions (pipeline_status);

-- media: every stored copy of a file ----------------------------------------
alter table media drop constraint if exists media_source_check;
alter table media add constraint media_source_check
  check (source in ('zoom','meet','upload','iphone_call','contractor_call',
                    'voice_memo','other'));
alter table media
  add column if not exists interaction_id   bigint references interactions(id) on delete cascade,
  add column if not exists kind             text,   -- video|audio|transcript_vtt|chat|cc|other
  add column if not exists role             text,   -- original|master|proxy|clip
  add column if not exists bucket           text,
  add column if not exists storage_class    text,
  add column if not exists sha256           text,
  add column if not exists bytes_expected   bigint,
  add column if not exists status           text,   -- pending|verified|verified_stable|failed|missing|deleted_local
  add column if not exists derived_from     bigint references media(id) on delete set null,
  add column if not exists source_file_id   text,
  add column if not exists verified_at      timestamptz,
  add column if not exists legacy_file_id   bigint,
  add column if not exists legacy_archive_id bigint;
-- storage values: 'zoom' (still only at Zoom), 'local' (a path on the Mac's
-- vault drive -- to be moved to R2), 'b2' | 's3_deep_archive' | 'r2'.
alter table media drop constraint if exists media_storage_storage_key_key;
create unique index if not exists media_location
  on media (storage, coalesce(bucket, ''), storage_key);
create index if not exists media_interaction on media (interaction_id);
create index if not exists media_sha on media (sha256);

-- transcripts ---------------------------------------------------------------
create table if not exists transcripts (
  interaction_id bigint primary key references interactions(id) on delete cascade,
  source        text not null,      -- zoom_vtt | whisper | groq | imported
  model         text,
  language      text,
  segment_count int,
  word_count    int,
  has_words     boolean not null default false,
  duration_sec  real,
  created_at    timestamptz default now()
);

-- segments: the unit a search hit points at ----------------------------------
create table if not exists segments (
  id             bigserial primary key,
  interaction_id bigint not null references interactions(id) on delete cascade,
  idx            int not null,
  start_sec      real not null,
  end_sec        real not null,
  speaker        text,
  speaker_party_id bigint references parties(id),
  text           text not null,
  words          jsonb,
  tsv            tsvector generated always as (to_tsvector('english', text)) stored,
  unique (interaction_id, idx)
);
create index if not exists segments_tsv on segments using gin (tsv);

-- clip scouting and cuts ------------------------------------------------------
create table if not exists clip_candidates (
  id             bigserial primary key,
  interaction_id bigint not null references interactions(id) on delete cascade,
  start_sec      real not null,
  end_sec        real not null,
  score          int not null,
  hook           text,
  why            text,
  platforms      text,
  status         text not null default 'new'
                 check (status in ('new','approved','rejected','cut')),
  model          text,
  clip_media_id  bigint references media(id) on delete set null,
  clip_path      text,
  cleared_at     timestamptz,
  legacy_id      bigint unique,
  created_at     timestamptz default now()
);
create index if not exists clip_candidates_status on clip_candidates (status, score desc);

create table if not exists clips (
  id             bigserial primary key,
  interaction_id bigint references interactions(id) on delete cascade,
  media_id       bigint references media(id) on delete set null,
  path           text,
  start_sec      real not null,
  end_sec        real not null,
  vertical       boolean not null default false,
  captions       boolean not null default false,
  source_role    text,
  bytes          bigint,
  legacy_id      bigint unique,
  created_at     timestamptz default now()
);

-- one row per import run, with the source manifest's counts -------------------
create table if not exists import_runs (
  id            bigserial primary key,
  source        text not null,
  source_sha256 text,
  counts_in     jsonb,
  counts_out    jsonb,
  started_at    timestamptz default now(),
  finished_at   timestamptz,
  ok            boolean
);

insert into schema_log (change, rationale)
select 'v0.2 recordings: interactions/media extended, transcripts, segments (tsvector), clip_candidates, clips, import_runs',
       'Moves meeting-vault off the single-file SQLite manifest so recordings live with people/projects'
where not exists (select 1 from schema_log where change like 'v0.2 recordings%');
