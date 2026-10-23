-- relationship-engine v0.4: the Strout Vault worker (Phase 4).
--
-- The worker replaces meeting-vault's `vault run`: it pulls new Zoom cloud
-- recordings straight into cold storage, transcribes them (Zoom VTT first,
-- Groq when allowed), and processes the upload queue. Everything it needs to
-- remember between runs lives here instead of a SQLite manifest on a Mac.
--
-- Additive only, safe to re-run. Nothing here is ever deleted by the app.

-- Small key/value store: Zoom sync cursor, last successful run, etc.
create table if not exists worker_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- One row per worker run (hourly on Replit). `summary` holds per-step counts
-- and the errors that did not stop the run, so the Pipeline page can show
-- what happened without reading deployment logs.
create table if not exists worker_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  trigger     text not null default 'schedule',   -- schedule | manual | test
  host        text,
  summary     jsonb,
  error       text
);
create index if not exists worker_runs_started on worker_runs (started_at desc);

-- Paid API usage, so monthly budgets are enforced from data rather than hope.
-- `units_sec` is audio seconds for speech-to-text and tokens are not tracked here.
create table if not exists spend_ledger (
  id             bigserial primary key,
  provider       text not null,                     -- groq | anthropic | ...
  model          text,
  interaction_id bigint references interactions(id) on delete set null,
  units_sec      real,
  usd            numeric(12, 8) not null,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists spend_ledger_month on spend_ledger (provider, created_at desc);

-- Download bookkeeping for originals the worker fetches (Zoom). A file that keeps
-- failing stops being retried after a few attempts instead of every hour forever.
alter table media
  add column if not exists attempts   int not null default 0,
  add column if not exists last_error text;
create index if not exists media_pending_downloads on media (status) where status in ('pending', 'failed');

insert into schema_log (change, rationale)
select 'v0.4 worker: worker_state, worker_runs, spend_ledger',
       'Strout Vault takes over meeting-vault''s pipeline: Zoom sync, transcription and the upload queue run as an hourly worker against this database'
where not exists (select 1 from schema_log where change like 'v0.4 worker%');
