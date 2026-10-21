import type pg from "pg";
import type { RoleChip } from "../../shared/types.ts";

export interface PartyListFilters {
  q?: string | null;
  kind?: "person" | "org" | null;
  workspaceId?: string | null;
  role?: string | null;
  status?: string | null;
  market?: string | null;
  limit?: number;
}

export interface PartyListItem {
  id: number;
  kind: string;
  name: string;
  location: string | null;
  emails: string[];
  roles: RoleChip[];
  /** "Another Story · contractor, Strout Architecture · client" for compact displays. */
  detail: string | null;
  interactionCount: number;
  lastSeenAt: string | null;
  orgs: Array<{ id: number; name: string }>;
}

const ROLE_JSON = `coalesce((
  select json_agg(json_build_object(
    'id', r.id, 'workspaceId', r.workspace_id, 'workspaceName', w.name, 'role', r.role,
    'status', r.status, 'market', r.market, 'detail', r.detail) order by w.name, r.role)
  from roles r join workspaces w on w.id = r.workspace_id where r.party_id = p.id), '[]'::json)`;

export async function listParties(pool: pg.Pool, f: PartyListFilters): Promise<PartyListItem[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  const term = f.q?.trim() ?? "";
  if (term) {
    const t = p(term);
    where.push(`(p.name ilike '%' || ${t} || '%' or exists (select 1 from unnest(p.emails) e where e ilike '%' || ${t} || '%'))`);
  }
  if (f.kind) where.push(`p.kind = ${p(f.kind)}`);
  const roleConds: string[] = [];
  if (f.workspaceId) roleConds.push(`r.workspace_id = ${p(f.workspaceId)}`);
  if (f.role) roleConds.push(`r.role = ${p(f.role)}`);
  if (f.status) roleConds.push(`r.status = ${p(f.status)}`);
  if (f.market) roleConds.push(`r.market ilike '%' || ${p(f.market)} || '%'`);
  if (roleConds.length) where.push(`exists (select 1 from roles r where r.party_id = p.id and ${roleConds.join(" and ")})`);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  const orderTerm = term ? `case when position(lower(${p(term)}) in lower(p.name)) = 0 then 1000 else position(lower(${p(term)}) in lower(p.name)) end,` : "";

  const { rows } = await pool.query(
    `select p.id, p.kind, p.name, p.location, p.emails,
            ${ROLE_JSON} as roles,
            (select count(*)::int from interaction_participants ip where ip.party_id = p.id) as interaction_count,
            (select max(i.occurred_at) from interaction_participants ip join interactions i on i.id = ip.interaction_id where ip.party_id = p.id) as last_seen_at,
            coalesce((select json_agg(json_build_object('id', o.id, 'name', o.name) order by o.name)
                      from affiliations a join parties o on o.id = a.org_id where a.person_id = p.id and coalesce(a.is_current, true)), '[]'::json) as orgs
     from parties p
     ${where.length ? "where " + where.join(" and ") : ""}
     order by ${orderTerm} p.name
     limit ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    location: r.location,
    emails: r.emails ?? [],
    roles: r.roles ?? [],
    detail: (r.roles as RoleChip[] | null)?.length
      ? [...new Set((r.roles as RoleChip[]).map((x) => `${x.workspaceName} · ${x.role}`))].join(", ")
      : null,
    interactionCount: r.interaction_count ?? 0,
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    orgs: r.orgs ?? [],
  }));
}

export async function getPartyDetail(pool: pg.Pool, id: number) {
  const { rows } = await pool.query(`select * from parties where id = $1`, [id]);
  const party = rows[0];
  if (!party) return null;
  const [roles, affiliations, interactions, facts, projects] = await Promise.all([
    pool.query(
      `select r.id, r.workspace_id, w.name as workspace_name, r.role, r.status, r.market, r.detail, r.started_at, r.ended_at
       from roles r join workspaces w on w.id = r.workspace_id where r.party_id = $1 order by w.name, r.role`,
      [id],
    ),
    pool.query(
      `select a.id, a.title, a.is_current,
              case when a.person_id = $1 then o.id else pe.id end as other_id,
              case when a.person_id = $1 then o.name else pe.name end as other_name,
              case when a.person_id = $1 then o.kind else pe.kind end as other_kind
       from affiliations a
       join parties pe on pe.id = a.person_id
       join parties o on o.id = a.org_id
       where a.person_id = $1 or a.org_id = $1
       order by a.is_current desc, other_name`,
      [id],
    ),
    pool.query(
      `select i.id, i.title, i.occurred_at, i.duration_sec, i.source, i.pipeline_status, i.workspace_id, ip.speaker_label
       from interaction_participants ip join interactions i on i.id = ip.interaction_id
       where ip.party_id = $1 order by i.occurred_at desc nulls last, i.id desc limit 300`,
      [id],
    ),
    pool.query(
      `select f.id, f.kind, f.text, f.status, f.quote_start_sec, f.due_date, f.amount, f.interaction_id, i.title as interaction_title, i.occurred_at,
              o.id as owner_id, o.name as owner_name, a.id as about_id, a.name as about_name
       from facts f
       left join interactions i on i.id = f.interaction_id
       left join parties o on o.id = f.owner_party_id
       left join parties a on a.id = f.about_party_id
       where f.owner_party_id = $1 or f.about_party_id = $1
       order by (f.status = 'open') desc, f.due_date nulls last, f.id desc limit 200`,
      [id],
    ),
    pool.query(
      `select pr.id, pr.name, pr.status, pr.workspace_id, w.name as workspace_name, pp.role
       from project_parties pp join projects pr on pr.id = pp.project_id join workspaces w on w.id = pr.workspace_id
       where pp.party_id = $1 order by pr.name`,
      [id],
    ),
  ]);
  return {
    id: party.id,
    kind: party.kind,
    name: party.name,
    emails: party.emails ?? [],
    phones: party.phones ?? [],
    location: party.location,
    website: party.website,
    notes: party.notes,
    createdAt: party.created_at ? new Date(party.created_at).toISOString() : null,
    updatedAt: party.updated_at ? new Date(party.updated_at).toISOString() : null,
    roles: roles.rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      role: r.role,
      status: r.status,
      market: r.market,
      detail: r.detail,
      startedAt: r.started_at ? String(r.started_at).slice(0, 10) : null,
      endedAt: r.ended_at ? String(r.ended_at).slice(0, 10) : null,
    })),
    affiliations: affiliations.rows.map((a) => ({
      id: a.id,
      title: a.title,
      isCurrent: a.is_current,
      other: { id: a.other_id, name: a.other_name, kind: a.other_kind },
    })),
    interactions: interactions.rows.map((i) => ({
      id: i.id,
      title: i.title,
      occurredAt: i.occurred_at ? new Date(i.occurred_at).toISOString() : null,
      durationSec: i.duration_sec,
      source: i.source,
      pipelineStatus: i.pipeline_status,
      workspaceId: i.workspace_id,
      speakerLabel: i.speaker_label,
    })),
    facts: facts.rows.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      quoteStartSec: f.quote_start_sec,
      dueDate: f.due_date ? String(f.due_date).slice(0, 10) : null,
      amount: f.amount,
      interaction: f.interaction_id ? { id: f.interaction_id, title: f.interaction_title, occurredAt: f.occurred_at ? new Date(f.occurred_at).toISOString() : null } : null,
      ownerParty: f.owner_id ? { id: f.owner_id, name: f.owner_name } : null,
      aboutParty: f.about_id ? { id: f.about_id, name: f.about_name } : null,
    })),
    projects: projects.rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      workspaceId: p.workspace_id,
      workspaceName: p.workspace_name,
      role: p.role,
    })),
  };
}

export interface PartyPatch {
  name?: string;
  emails?: string[];
  phones?: string[];
  location?: string | null;
  website?: string | null;
  notes?: string | null;
}

export async function updateParty(pool: pg.Pool, id: number, patch: PartyPatch): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.name !== undefined) sets.push(`name = ${p(patch.name)}`);
  if (patch.emails !== undefined) sets.push(`emails = ${p(patch.emails)}::text[]`);
  if (patch.phones !== undefined) sets.push(`phones = ${p(patch.phones)}::text[]`);
  if (patch.location !== undefined) sets.push(`location = ${p(patch.location)}`);
  if (patch.website !== undefined) sets.push(`website = ${p(patch.website)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${p(patch.notes)}`);
  if (!sets.length) return true;
  sets.push("updated_at = now()");
  const res = await pool.query(`update parties set ${sets.join(", ")} where id = ${p(id)}`, params);
  return (res.rowCount ?? 0) > 0;
}

export async function createParty(pool: pg.Pool, input: { kind: "person" | "org"; name: string; emails?: string[]; phones?: string[]; location?: string | null }) {
  const { rows } = await pool.query(
    `insert into parties (kind, name, emails, phones, location) values ($1, $2, $3::text[], $4::text[], $5) returning id`,
    [input.kind, input.name.trim(), input.emails ?? [], input.phones ?? [], input.location ?? null],
  );
  return rows[0].id as number;
}

export const ROLE_VALUES = ["client", "contractor", "vendor", "partner", "investor", "team", "prospect", "advisor", "other"] as const;
export const ROLE_STATUS_VALUES = ["prospect", "active", "paused", "former"] as const;

/** Adds or updates a party's role in a workspace (unique on workspace, party, role). Roles are never deleted; mark them 'former'. */
export async function upsertRole(
  pool: pg.Pool,
  partyId: number,
  input: { workspaceId: string; role: string; status?: string; market?: string | null; detail?: string | null },
) {
  const { rows } = await pool.query(
    `insert into roles (workspace_id, party_id, role, status, market, detail)
     values ($1, $2, $3, coalesce($4, 'active'), $5, $6)
     on conflict (workspace_id, party_id, role) do update
       set status = coalesce(excluded.status, roles.status),
           market = coalesce(excluded.market, roles.market),
           detail = coalesce(excluded.detail, roles.detail)
     returning id`,
    [input.workspaceId, partyId, input.role, input.status ?? null, input.market ?? null, input.detail ?? null],
  );
  return rows[0].id as number;
}

export async function updateRole(pool: pg.Pool, roleId: number, patch: { status?: string; market?: string | null; detail?: string | null }): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.status !== undefined) sets.push(`status = ${p(patch.status)}`);
  if (patch.market !== undefined) sets.push(`market = ${p(patch.market)}`);
  if (patch.detail !== undefined) sets.push(`detail = ${p(patch.detail)}`);
  if (!sets.length) return true;
  const res = await pool.query(`update roles set ${sets.join(", ")} where id = ${p(roleId)}`, params);
  return (res.rowCount ?? 0) > 0;
}

export async function upsertAffiliation(pool: pg.Pool, personId: number, orgId: number, title: string | null) {
  await pool.query(
    `insert into affiliations (person_id, org_id, title, is_current) values ($1, $2, $3, true)
     on conflict (person_id, org_id) do update set title = coalesce(excluded.title, affiliations.title), is_current = true`,
    [personId, orgId, title],
  );
}

/** Distinct markets seen in roles, for the filter dropdown. */
export async function listMarkets(pool: pg.Pool, workspaceId?: string | null): Promise<string[]> {
  const { rows } = await pool.query(
    `select distinct market from roles where market is not null and market <> '' ${workspaceId ? "and workspace_id = $1" : ""} order by market`,
    workspaceId ? [workspaceId] : [],
  );
  return rows.map((r) => r.market as string);
}
