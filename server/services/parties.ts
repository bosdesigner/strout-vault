import type pg from "pg";
import type { PartySuggestion } from "../../shared/types.ts";

export async function suggestParties(pool: pg.Pool, q: string, limit = 10): Promise<PartySuggestion[]> {
  const term = q.trim();
  const { rows } = await pool.query(
    `select p.id, p.name, p.kind,
            (select string_agg(distinct w.name || ' · ' || r.role, ', ' order by w.name || ' · ' || r.role)
               from roles r join workspaces w on w.id = r.workspace_id where r.party_id = p.id) as detail
     from parties p
     where $1 = '' or p.name ilike '%' || $1 || '%' or exists (select 1 from unnest(p.emails) e where e ilike '%' || $1 || '%')
     order by case when $1 = '' or position(lower($1) in lower(p.name)) = 0 then 1000 else position(lower($1) in lower(p.name)) end, p.name
     limit $2`,
    [term, limit],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, detail: r.detail }));
}

export async function getParty(pool: pg.Pool, id: number) {
  const { rows } = await pool.query(`select * from parties where id = $1`, [id]);
  const party = rows[0];
  if (!party) return null;
  const [roles, affiliations, interactions] = await Promise.all([
    pool.query(
      `select r.workspace_id, w.name as workspace_name, r.role, r.status, r.market, r.detail
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
      `select i.id, i.title, i.occurred_at, i.duration_sec, i.source, i.pipeline_status
       from interaction_participants ip join interactions i on i.id = ip.interaction_id
       where ip.party_id = $1 order by i.occurred_at desc nulls last limit 100`,
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
    roles: roles.rows.map((r) => ({
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      role: r.role,
      status: r.status,
      market: r.market,
      detail: r.detail,
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
    })),
  };
}

export async function listWorkspaces(pool: pg.Pool) {
  const { rows } = await pool.query(`select id, name from workspaces order by name`);
  return rows as Array<{ id: string; name: string }>;
}
