-- v0.3 access and call capture (Phase 3). Additive, idempotent, safe to re-run.
--
--   memberships      who can log in, scoped to one workspace and (optionally) to
--                    their own party row. Contractors see only interactions they
--                    took part in or uploaded. The env-configured owner needs no row.
--   login_tokens     single-use, hashed magic-link tokens for contractor logins.
--   tracked_numbers  one forwarding phone number per contractor (Twilio).
--   calls            every call that reached a tracked number, with the recording
--                    once it has been copied into R2 and turned into an interaction.

create table if not exists memberships (
  id            bigserial primary key,
  email         text not null,
  role          text not null default 'contractor' check (role in ('owner','contractor')),
  workspace_id  text references workspaces(id),          -- null only for an owner
  party_id      bigint references parties(id),           -- this login's own person row
  status        text not null default 'invited' check (status in ('invited','active','disabled')),
  display_name  text,
  invited_by    text,
  created_at    timestamptz default now(),
  last_login_at timestamptz
);
create unique index if not exists memberships_email_workspace
  on memberships (lower(email), coalesce(workspace_id, ''));

create table if not exists login_tokens (
  id            bigserial primary key,
  membership_id bigint not null references memberships(id),
  token_hash    text not null unique,                    -- sha256 of the token; the token itself is never stored
  expires_at    timestamptz not null,
  used_at       timestamptz,
  requested_ip  text,
  created_at    timestamptz default now()
);
create index if not exists login_tokens_membership on login_tokens (membership_id);

create table if not exists tracked_numbers (
  id               bigserial primary key,
  workspace_id     text references workspaces(id),
  membership_id    bigint references memberships(id),
  party_id         bigint references parties(id),         -- the contractor who owns the number
  phone_number     text not null unique,                  -- the Twilio number, E.164
  forward_to       text not null,                         -- the contractor's real phone, E.164
  twilio_sid       text,
  recording_notice text,                                  -- what callers hear before the call connects
  status           text not null default 'active' check (status in ('active','paused','released')),
  created_at       timestamptz default now()
);

create table if not exists calls (
  id                bigserial primary key,
  tracked_number_id bigint references tracked_numbers(id),
  call_sid          text not null unique,
  direction         text not null default 'inbound',
  from_number       text,
  to_number         text,
  caller_party_id   bigint references parties(id),        -- matched by caller id against parties.phones
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_sec      int,
  status            text,                                 -- ringing | in-progress | completed | no-answer | busy | failed
  recording_sid     text,
  recording_url     text,                                 -- Twilio's URL; fetched once, then the copy in R2 is used
  recording_status  text,                                 -- pending | stored | failed
  recording_error   text,
  media_id          bigint references media(id),
  interaction_id    bigint references interactions(id),
  raw               jsonb,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists calls_tracked_number on calls (tracked_number_id);
create index if not exists calls_from_number on calls (from_number);
create index if not exists calls_interaction on calls (interaction_id);

insert into schema_log (change, rationale)
select 'v0.3 access and calls: memberships, login_tokens, tracked_numbers, calls',
       'Contractor logins scoped to a workspace (magic links) and Twilio-tracked numbers whose recordings land in the vault as contractor_call interactions'
where not exists (select 1 from schema_log where change like 'v0.3 access and calls%');
