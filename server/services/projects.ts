import type pg from "pg";

export async function listProjects(pool: pg.Pool, f: { workspaceId?: string | null; status?: string | null; q?: string | null }) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.workspaceId) where.push(`pr.workspace_id = ${p(f.workspaceId)}`);
  if (f.status) where.push(`pr.status = ${p(f.status)}`);
  if (f.q?.trim()) where.push(`(pr.name ilike '%' || ${p(f.q.trim())} || '%' or pr.address ilike '%' || ${p(f.q.trim())} || '%')`);
  const { rows } = await pool.query(
    `select pr.id, pr.workspace_id, w.name as workspace_name, pr.name, pr.address, pr.status, pr.updated_at,
            (select count(*)::int from project_parties pp where pp.project_id = pr.id) as party_count,
            (select count(*)::int from interaction_links il where il.project_id = pr.id) as interaction_count,
            (select count(*)::int from facts f where f.project_id = pr.id and f.status = 'open') as open_facts,
            (select max(i.occurred_at) from interaction_links il join interactions i on i.id = il.interaction_id where il.project_id = pr.id) as last_activity,
            coalesce((select json_agg(json_build_object('id', pa.id, 'name', pa.name, 'role', pp.role) order by pp.role, pa.name)
                      from project_parties pp join parties pa on pa.id = pp.party_id where pp.project_id = pr.id), '[]'::json) as parties
     from projects pr join workspaces w on w.id = pr.workspace_id
     ${where.length ? "where " + where.join(" and ") : ""}
     order by coalesce(pr.updated_at, pr.created_at) desc, pr.name
     limit 500`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    name: r.name,
    address: r.address,
    status: r.status,
    partyCount: r.party_count,
    interactionCount: r.interaction_count,
    openFacts: r.open_facts,
    lastActivityAt: r.last_activity ? new Date(r.last_activity).toISOString() : null,
    parties: r.parties ?? [],
  }));
}

export async function getProject(pool: pg.Pool, id: number) {
  const { rows } = await pool.query(
    `select pr.*, w.name as workspace_name from projects pr join workspaces w on w.id = pr.workspace_id where pr.id = $1`,
    [id],
  );
  const pr = rows[0];
  if (!pr) return null;
  const [parties, interactions, facts] = await Promise.all([
    pool.query(
      `select pa.id, pa.kind, pa.name, pp.role as project_role,
              coalesce((select json_agg(json_build_object('workspaceId', r.workspace_id, 'workspaceName', w.name, 'role', r.role, 'status', r.status, 'market', r.market, 'detail', r.detail) order by w.name, r.role)
                        from roles r join workspaces w on w.id = r.workspace_id where r.party_id = pa.id), '[]'::json) as roles
       from project_parties pp join parties pa on pa.id = pp.party_id where pp.project_id = $1 order by pp.role, pa.name`,
      [id],
    ),
    pool.query(
      `select i.id, i.title, i.occurred_at, i.duration_sec, i.source, i.pipeline_status
       from interaction_links il join interactions i on i.id = il.interaction_id where il.project_id = $1
       order by i.occurred_at desc nulls last, i.id desc limit 300`,
      [id],
    ),
    pool.query(
      `select f.id, f.kind, f.text, f.status, f.quote_start_sec, f.due_date, f.amount, f.interaction_id, i.title as interaction_title,
              o.id as owner_id, o.name as owner_name
       from facts f left join interactions i on i.id = f.interaction_id left join parties o on o.id = f.owner_party_id
       where f.project_id = $1 order by (f.status = 'open') desc, f.due_date nulls last, f.id desc limit 200`,
      [id],
    ),
  ]);
  return {
    id: pr.id,
    workspaceId: pr.workspace_id,
    workspaceName: pr.workspace_name,
    name: pr.name,
    address: pr.address,
    status: pr.status,
    notes: pr.notes,
    createdAt: pr.created_at ? new Date(pr.created_at).toISOString() : null,
    updatedAt: pr.updated_at ? new Date(pr.updated_at).toISOString() : null,
    parties: parties.rows.map((p) => ({ id: p.id, kind: p.kind, name: p.name, projectRole: p.project_role, roles: p.roles ?? [] })),
    interactions: interactions.rows.map((i) => ({
      id: i.id,
      title: i.title,
      occurredAt: i.occurred_at ? new Date(i.occurred_at).toISOString() : null,
      durationSec: i.duration_sec,
      source: i.source,
      pipelineStatus: i.pipeline_status,
    })),
    facts: facts.rows.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      quoteStartSec: f.quote_start_sec,
      dueDate: f.due_date ? String(f.due_date).slice(0, 10) : null,
      amount: f.amount,
      interaction: f.interaction_id ? { id: f.interaction_id, title: f.interaction_title } : null,
      ownerParty: f.owner_id ? { id: f.owner_id, name: f.owner_name } : null,
    })),
  };
}

export async function updateProject(pool: pg.Pool, id: number, patch: { name?: string; address?: string | null; status?: string | null; notes?: string | null }): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.name !== undefined) sets.push(`name = ${p(patch.name)}`);
  if (patch.address !== undefined) sets.push(`address = ${p(patch.address)}`);
  if (patch.status !== undefined) sets.push(`status = ${p(patch.status)}`);
  if (patch.notes !== undefined) sets.push(`notes = ${p(patch.notes)}`);
  if (!sets.length) return true;
  sets.push("updated_at = now()");
  const res = await pool.query(`update projects set ${sets.join(", ")} where id = ${p(id)}`, params);
  return (res.rowCount ?? 0) > 0;
}

export async function createProject(pool: pg.Pool, input: { workspaceId: string; name: string; address?: string | null; status?: string | null }) {
  const { rows } = await pool.query(
    `insert into projects (workspace_id, name, address, status) values ($1, $2, $3, $4) returning id`,
    [input.workspaceId, input.name.trim(), input.address ?? null, input.status ?? "active"],
  );
  return rows[0].id as number;
}

export async function addProjectParty(pool: pg.Pool, projectId: number, partyId: number, role: string) {
  await pool.query(`insert into project_parties (project_id, party_id, role) values ($1, $2, $3) on conflict do nothing`, [projectId, partyId, role]);
}

export async function linkInteractionToProject(pool: pg.Pool, interactionId: number, projectId: number) {
  await pool.query(`insert into interaction_links (interaction_id, project_id) values ($1, $2) on conflict do nothing`, [interactionId, projectId]);
}

/** Tags a party on a recording; with a speaker label, also assigns that label's lines to the party. */
export async function addInteractionParticipant(
  pool: pg.Pool,
  interactionId: number,
  partyId: number,
  speakerLabel: string | null,
): Promise<{ linesAssigned: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into interaction_participants (interaction_id, party_id, speaker_label, confidence)
       values ($1, $2, $3, 1.0)
       on conflict (interaction_id, party_id) do update set speaker_label = coalesce(excluded.speaker_label, interaction_participants.speaker_label), confidence = 1.0`,
      [interactionId, partyId, speakerLabel],
    );
    let linesAssigned = 0;
    if (speakerLabel) {
      const res = await client.query(
        `update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and (speaker_party_id is null or speaker_party_id <> $2)`,
        [interactionId, partyId, speakerLabel],
      );
      linesAssigned = res.rowCount ?? 0;
    }
    await client.query("commit");
    return { linesAssigned };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Speaker labels in a recording's transcript and which party (if any) they are assigned to. */
export async function speakerLabels(pool: pg.Pool, interactionId: number) {
  const { rows } = await pool.query(
    `select speaker, min(speaker_party_id) as party_id, count(*)::int as lines
     from segments where interaction_id = $1 and speaker is not null group by speaker order by min(idx)`,
    [interactionId],
  );
  return rows.map((r) => ({ label: r.speaker as string, partyId: (r.party_id as number | null) ?? null, lines: r.lines as number }));
}
