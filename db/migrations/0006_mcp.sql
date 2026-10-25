-- relationship-engine v0.6: the vault MCP server and semantic search (Jarvis step 1).
--
--   chunks                 gets the two indexes it never had: HNSW (cosine) on the
--                          embedding for vector search, and (interaction_id, seq) for
--                          rebuilding one recording's chunks and reading them in order.
--   interactions           embedding bookkeeping (embedded_at, embed_model, embed_error,
--                          embed_attempts), the same pattern as scouted_at / scout_error.
--   api_tokens             personal access tokens for Claude Code and scheduled jobs.
--                          Shown once, stored as a SHA-256 hash, revocable, workspace-scoped.
--   oauth_clients          dynamically registered OAuth 2.1 clients (Claude.ai connectors).
--   oauth_codes            short-lived authorization codes (hashed) with their PKCE challenge.
--   oauth_tokens           access (1 h) and refresh (rotated) tokens, hashed, workspace-scoped.
--   mcp_audit              one row per tool call: who, what, how long, what came back.
--   role grants            mcp_reader (SELECT only) and mcp_proposer (INSERT review_queue only),
--                          applied only when the role exists. Create the roles first: see
--                          docs/MCP.md "Neon roles". `npm run db:local` creates them locally.
--
-- Additive and idempotent, safe to re-run. Nothing here is ever deleted by the app.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0006_mcp.sql); the app never runs DDL.

create extension if not exists vector;

-- chunks: the two indexes --------------------------------------------------------
-- HNSW build is CPU-heavy on a large table: on ~400k chunks allow a few minutes on Neon.
create index if not exists chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_interaction_seq on chunks (interaction_id, seq);

-- interactions: embedding bookkeeping ---------------------------------------------
alter table interactions
  add column if not exists embedded_at    timestamptz,
  add column if not exists embed_model    text,
  add column if not exists embed_error    text,
  add column if not exists embed_attempts int not null default 0;
create index if not exists interactions_embedding_pending on interactions (embedded_at) where embedded_at is null;

-- personal access tokens ----------------------------------------------------------
create table if not exists api_tokens (
  id              bigserial primary key,
  name            text not null,
  token_hash      text not null unique,          -- sha256 of the token; the token itself is shown once and never stored
  token_prefix    text not null,                 -- "svt_" + first 6 chars, so a token can be recognised in lists and logs
  workspace_scope jsonb not null default '[]'::jsonb,  -- ["another_story", ...] or ["*"] (all but phalanx) or ["*", "phalanx"]
  created_by      text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz
);

-- OAuth 2.1 authorization server (Claude.ai custom connectors) --------------------
create table if not exists oauth_clients (
  client_id                text primary key,
  client_secret            text,                 -- null for public clients (token_endpoint_auth_method = none)
  client_secret_expires_at timestamptz,
  client_name              text,
  redirect_uris            text[] not null default '{}',
  metadata                 jsonb not null default '{}'::jsonb,  -- the registration request, verbatim
  workspace_scope          jsonb not null default '[]'::jsonb,  -- what the owner granted at the last consent
  consented_by             text,
  consented_at             timestamptz,
  created_at               timestamptz not null default now(),
  last_used_at             timestamptz,
  revoked_at               timestamptz
);

create table if not exists oauth_codes (
  code_hash       text primary key,
  client_id       text not null references oauth_clients(client_id),
  code_challenge  text not null,
  redirect_uri    text not null,
  scopes          text[] not null default '{}',
  workspace_scope jsonb not null default '[]'::jsonb,
  resource        text,
  user_email      text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists oauth_tokens (
  id              bigserial primary key,
  token_hash      text not null unique,
  kind            text not null check (kind in ('access', 'refresh')),
  client_id       text not null references oauth_clients(client_id),
  grant_id        text not null,                 -- one authorization = one grant; refresh rotation stays in the family
  scopes          text[] not null default '{}',
  workspace_scope jsonb not null default '[]'::jsonb,
  resource        text,
  user_email      text not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  replaced_by     bigint references oauth_tokens(id),   -- set on a refresh token once it has been rotated
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);
create index if not exists oauth_tokens_client on oauth_tokens (client_id, kind);
create index if not exists oauth_tokens_grant on oauth_tokens (grant_id);

-- audit: every MCP tool call ------------------------------------------------------
create table if not exists mcp_audit (
  id              bigserial primary key,
  token_id        text not null,                 -- "pat:<api_tokens.id>" or "oauth:<oauth_tokens.id>"
  client_name     text,
  tool            text not null,
  args            jsonb,                         -- redacted: long strings truncated, secret-looking keys dropped
  workspace_scope jsonb,
  result_count    int,
  duration_ms     int,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists mcp_audit_created on mcp_audit (created_at desc);
create index if not exists mcp_audit_token on mcp_audit (token_id, created_at desc);
create index if not exists mcp_audit_tool on mcp_audit (tool, created_at desc);

-- role grants ----------------------------------------------------------------------
-- The MCP read tools connect as mcp_reader (SELECT only, on the tables the tools read).
-- propose_update connects as mcp_proposer, which can only INSERT into review_queue
-- (plus USAGE on its id sequence for nextval/currval). Neither role can touch anything
-- else, whatever the application code does. Grants are skipped with a NOTICE when a role
-- does not exist yet, so this file is safe to apply before the roles are created and
-- safe to re-apply after.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    grant usage on schema public to mcp_reader;
    grant select on workspaces, parties, roles, affiliations, projects, project_parties,
                    interactions, interaction_participants, interaction_links, facts,
                    relationships, chunks, segments, transcripts, review_queue, media
      to mcp_reader;
  else
    raise notice 'role mcp_reader does not exist: grants skipped (create it, then re-apply this file)';
  end if;

  if exists (select 1 from pg_roles where rolname = 'mcp_proposer') then
    grant usage on schema public to mcp_proposer;
    grant insert on review_queue to mcp_proposer;
    grant usage on sequence review_queue_id_seq to mcp_proposer;
  else
    raise notice 'role mcp_proposer does not exist: grants skipped (create it, then re-apply this file)';
  end if;
end $$;

insert into schema_log (change, rationale)
select 'v0.6 mcp: chunks indexes, embedding bookkeeping, api_tokens, oauth_clients/codes/tokens, mcp_audit, mcp_reader/mcp_proposer grants',
       'The vault MCP server (Streamable HTTP at /mcp) lets Claude.ai, Claude Code and scheduled jobs query the archive with workspace-scoped tokens; chunks are filled by the embedding worker for hybrid search'
where not exists (select 1 from schema_log where change like 'v0.6 mcp%');
