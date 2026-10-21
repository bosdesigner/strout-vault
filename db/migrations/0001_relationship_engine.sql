-- relationship-engine v0.1 (applied to Neon project dry-snow-01633657 on 2026-10-20).
-- Designed by Ben Strout with Claude, independently of any third-party system.
-- Seed data (workspaces, parties, roles, projects) was loaded separately.

create extension if not exists vector;
create extension if not exists pg_trgm;

create table workspaces (id text primary key, name text not null, owner text not null default 'Ben Strout', notes text, created_at timestamptz default now());

create table parties (id bigserial primary key, kind text not null check (kind in ('person','org')), name text not null, emails text[] default '{}', phones text[] default '{}', location text, website text, external_refs jsonb default '{}', notes text, created_at timestamptz default now(), updated_at timestamptz default now());
create index parties_name_trgm on parties using gin (name gin_trgm_ops);

create table roles (id bigserial primary key, workspace_id text not null references workspaces(id), party_id bigint not null references parties(id), role text not null check (role in ('client','contractor','vendor','partner','investor','team','prospect','advisor','other')), status text not null default 'active' check (status in ('prospect','active','paused','former')), market text, detail text, started_at date, ended_at date, source_interaction_id bigint, created_at timestamptz default now(), unique (workspace_id, party_id, role));

create table affiliations (id bigserial primary key, person_id bigint not null references parties(id), org_id bigint not null references parties(id), title text, is_current boolean default true, unique (person_id, org_id));

create table projects (id bigserial primary key, workspace_id text not null references workspaces(id), name text not null, address text, status text, external_refs jsonb default '{}', notes text, created_at timestamptz default now(), updated_at timestamptz default now());

create table project_parties (project_id bigint references projects(id), party_id bigint references parties(id), role text not null, primary key (project_id, party_id, role));

create table media (id bigserial primary key, workspace_id text references workspaces(id), source text not null check (source in ('zoom','upload','iphone_call','contractor_call','voice_memo','other')), storage text not null default 'r2', storage_key text not null, mime_type text, bytes bigint, duration_sec int, recorded_at timestamptz, uploaded_by bigint references parties(id), consent_notice boolean, original_filename text, created_at timestamptz default now(), unique (storage, storage_key));

create table jobs (id bigserial primary key, media_id bigint not null references media(id), stage text not null check (stage in ('transcribe','extract','index','clip')), status text not null default 'pending' check (status in ('pending','running','done','failed','skipped')), attempts int default 0, error text, updated_at timestamptz default now(), unique (media_id, stage));

create table interactions (id bigserial primary key, workspace_id text references workspaces(id), media_id bigint references media(id), kind text not null check (kind in ('call','meeting','email','text','in_person','other')), occurred_at timestamptz, title text, summary text, transcript text, transcript_segments jsonb, created_at timestamptz default now());

create table interaction_participants (interaction_id bigint references interactions(id), party_id bigint references parties(id), speaker_label text, confidence real, primary key (interaction_id, party_id));

create table interaction_links (interaction_id bigint references interactions(id), project_id bigint references projects(id), primary key (interaction_id, project_id));

create table facts (id bigserial primary key, interaction_id bigint references interactions(id), workspace_id text references workspaces(id), kind text not null check (kind in ('commitment','decision','price','followup','issue','preference','other')), text text not null, owner_party_id bigint references parties(id), about_party_id bigint references parties(id), project_id bigint references projects(id), amount numeric, due_date date, status text default 'open', confidence real, quote_start_sec int, created_at timestamptz default now());

create table relationships (id bigserial primary key, from_party_id bigint not null references parties(id), to_party_id bigint not null references parties(id), kind text not null, workspace_id text references workspaces(id), first_seen timestamptz, last_seen timestamptz, evidence_count int default 0, notes text, unique (from_party_id, to_party_id, kind, workspace_id));

create table chunks (id bigserial primary key, interaction_id bigint references interactions(id) on delete cascade, seq int, start_sec int, end_sec int, text text not null, embedding vector(1024));

create table review_queue (id bigserial primary key, item_type text not null, proposal jsonb not null, reason text, interaction_id bigint references interactions(id), status text default 'open' check (status in ('open','approved','rejected')), decided_at timestamptz, created_at timestamptz default now());

create table schema_log (id bigserial primary key, change text not null, rationale text, created_at timestamptz default now());
