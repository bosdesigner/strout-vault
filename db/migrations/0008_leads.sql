-- relationship-engine v0.8: leads come into the vault (Jarvis step 3).
--
--   lead_records   one row per lead as its source holds it: the platform's `leads` and
--                  `site_leads` tables (AnotherStoryBLDR, read-only) and the Airtable
--                  "Client Pipeline" base (contact, contractor_intake, archived). The hourly
--                  worker upserts by (origin, origin_id), so a re-sync updates stage and
--                  status and never duplicates. Each row points at the party it resolved to
--                  (matched by email, then phone, or created), and that party gets a
--                  `prospect` role in the lead's workspace, so leads show up on People, in
--                  get_party, in the extractor's roster and in the MCP list_leads tool.
--
-- The sources stay the systems of record: the vault only reads them and never writes back.
-- Additive and idempotent, safe to re-run.
-- Apply by hand (psql "$DATABASE_URL" -f db/migrations/0008_leads.sql); the app never runs DDL.

create table if not exists lead_records (
  id                bigserial primary key,
  origin            text not null check (origin in ('platform_leads', 'platform_site_leads', 'airtable_contact', 'airtable_contractor_intake', 'airtable_archived')),
  origin_id         text not null,
  party_id          bigint references parties(id) on delete set null,
  workspace_id      text references workspaces(id),
  lead_type         text not null default 'other' check (lead_type in ('homeowner', 'contractor', 'other')),
  name              text,
  email             text,
  phone             text,
  company           text,
  address           text,
  zip               text,
  market            text,
  channel           text,          -- where it came from inside the source: kind, site host, form
  stage             text,          -- the source's pipeline stage (Airtable stage, recruit_stage)
  status            text,          -- the source's status (new, contacted, nurture, dead, converted…)
  notes             text,
  details           jsonb not null default '{}',
  submitted_at      timestamptz,
  origin_updated_at timestamptz,
  first_synced_at   timestamptz not null default now(),
  last_synced_at    timestamptz not null default now(),
  unique (origin, origin_id)
);
create index if not exists lead_records_party on lead_records (party_id);
create index if not exists lead_records_submitted on lead_records (submitted_at desc);
create index if not exists lead_records_email on lead_records (lower(email));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    grant select on lead_records to mcp_reader;
  end if;
end $$;

insert into schema_log (change, rationale)
select 'v0.8 leads: lead_records (platform leads + site_leads, Airtable Client Pipeline)',
       'Every lead, from the platform and from Airtable, becomes a party with a prospect role so Jarvis can track and follow up on it'
where not exists (select 1 from schema_log where change like 'v0.8 leads%');
