import type pg from "pg";
import { PROPOSAL_SCHEMAS, type ProposalType } from "../mcp/tools/propose.ts";

export interface ReviewItem {
  id: number;
  itemType: string;
  proposal: Record<string, unknown>;
  reason: string | null;
  status: string;
  createdAt: string | null;
  decidedAt: string | null;
  interaction: { id: number; title: string | null; occurredAt: string | null; workspaceId: string | null } | null;
  party: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
  speakerLabel: string | null;
  startSec: number | null;
  confidence: number | null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export async function listReview(pool: pg.Pool, f: { status?: string | null; workspaceId?: string | null; limit?: number }): Promise<ReviewItem[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.status && f.status !== "all") where.push(`rq.status = ${p(f.status)}`);
  if (f.workspaceId) where.push(`i.workspace_id = ${p(f.workspaceId)}`);
  const { rows } = await pool.query(
    `select rq.id, rq.item_type, rq.proposal, rq.reason, rq.status, rq.created_at, rq.decided_at,
            i.id as interaction_id, i.title, i.occurred_at, i.workspace_id,
            pa.id as party_id, pa.name as party_name, pr.id as project_id, pr.name as project_name
     from review_queue rq
     left join interactions i on i.id = rq.interaction_id
     left join parties pa on pa.id = nullif(rq.proposal->>'party_id', '')::bigint
     left join projects pr on pr.id = nullif(rq.proposal->>'project_id', '')::bigint
     ${where.length ? "where " + where.join(" and ") : ""}
     order by (rq.status = 'open') desc, rq.created_at asc, rq.id asc
     limit ${Math.min(Math.max(f.limit ?? 200, 1), 500)}`,
    params,
  );
  return rows.map(toItem);
}

function toItem(r: Record<string, unknown>): ReviewItem {
  const proposal = (r.proposal ?? {}) as Record<string, unknown>;
  return {
    id: r.id as number,
    itemType: r.item_type as string,
    proposal,
    reason: (r.reason as string | null) ?? null,
    status: r.status as string,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
    interaction: r.interaction_id
      ? { id: r.interaction_id as number, title: (r.title as string | null) ?? null, occurredAt: r.occurred_at ? new Date(r.occurred_at as string).toISOString() : null, workspaceId: (r.workspace_id as string | null) ?? null }
      : null,
    party: r.party_id ? { id: r.party_id as number, name: r.party_name as string } : null,
    project: r.project_id ? { id: Number(r.project_id), name: r.project_name as string } : null,
    speakerLabel: (proposal.speaker_label as string | undefined) ?? null,
    startSec: num(proposal.start_sec ?? proposal.quote_start_sec),
    confidence: num(proposal.confidence),
  };
}

export async function countOpenReview(pool: pg.Pool, workspaceId?: string | null): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from review_queue rq left join interactions i on i.id = rq.interaction_id
     where rq.status = 'open' ${workspaceId ? "and i.workspace_id = $1" : ""}`,
    workspaceId ? [workspaceId] : [],
  );
  return rows[0].n;
}

export class ReviewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Applies or rejects a proposal. Approving a `participant_match` inserts the
 * interaction_participants row, assigns the speaker label's lines
 * (segments.speaker_party_id) and marks the item approved, all in one
 * transaction. The propose_update types (new_party, party_edit, link_*, new_fact,
 * new_relationship) are applied by APPLIERS below; an item that no longer applies
 * (a party or recording that was deleted, an invalid shape) fails with 400 and stays open.
 */
export async function decideReview(pool: pg.Pool, id: number, decision: "approve" | "reject"): Promise<{ item: ReviewItem; applied: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select * from review_queue where id = $1 for update`, [id]);
    const row = rows[0];
    if (!row) throw new ReviewError(404, "review item not found");
    if (row.status !== "open") throw new ReviewError(409, `already ${row.status}`);
    const applied: string[] = [];
    if (decision === "approve") {
      const proposal = (row.proposal ?? {}) as Record<string, unknown>;
      if (row.item_type === "participant_match") {
        const interactionId = num(proposal.interaction_id) ?? (row.interaction_id as number | null);
        const partyId = num(proposal.party_id);
        const label = typeof proposal.speaker_label === "string" ? proposal.speaker_label : null;
        if (!interactionId || !partyId) throw new ReviewError(400, "proposal is missing interaction_id or party_id");
        await client.query(
          `insert into interaction_participants (interaction_id, party_id, speaker_label, confidence)
           values ($1, $2, $3, $4)
           on conflict (interaction_id, party_id) do update
             set speaker_label = coalesce(excluded.speaker_label, interaction_participants.speaker_label),
                 confidence = greatest(coalesce(interaction_participants.confidence, 0), coalesce(excluded.confidence, 0))`,
          [interactionId, partyId, label, num(proposal.confidence) ?? 1],
        );
        applied.push("interaction_participants");
        if (label) {
          const res = await client.query(
            `update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and speaker_party_id is null`,
            [interactionId, partyId, label],
          );
          applied.push(`segments.speaker_party_id (${res.rowCount ?? 0} lines)`);
        }
      } else if (row.item_type in APPLIERS) {
        // The propose_update tool's types (MCP agents) and the extraction step's proposals.
        applied.push(...(await APPLIERS[row.item_type as ProposalType](client, proposal, row)));
      } else if (row.item_type === "interaction_workspace" || row.item_type === "workspace_assignment") {
        // Files a recording under a workspace (scripts/propose-workspaces.ts queues interaction_workspace;
        // the message ingest queues workspace_assignment for texts and email it left in inbox).
        const interactionId = num(proposal.interaction_id) ?? (row.interaction_id as number | null);
        const workspaceId = typeof proposal.workspace_id === "string" ? proposal.workspace_id : null;
        if (interactionId && !workspaceId) throw new ReviewError(400, "no workspace was suggested for this thread: reject it and file the thread from its page");
        if (!interactionId || !workspaceId) throw new ReviewError(400, "proposal is missing interaction_id or workspace_id");
        const ws = await client.query(`select 1 from workspaces where id = $1`, [workspaceId]);
        if (!ws.rowCount) throw new ReviewError(400, `unknown workspace ${workspaceId}`);
        const res = await client.query(`update interactions set workspace_id = $2, updated_at = now() where id = $1`, [interactionId, workspaceId]);
        if (!res.rowCount) throw new ReviewError(400, `unknown interaction ${interactionId}`);
        applied.push(`interactions.workspace_id = ${workspaceId}`);
      }
    }
    const updated = await client.query(
      `update review_queue set status = $2, decided_at = now() where id = $1 returning *`,
      [id, decision === "approve" ? "approved" : "rejected"],
    );
    await client.query("commit");
    const items = await listReviewById(pool, updated.rows[0].id as number);
    return { item: items!, applied };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Decides several items in order; one failure is recorded and the rest continue. */
export async function decideReviewBulk(pool: pg.Pool, ids: number[], decision: "approve" | "reject"): Promise<{ done: number; failed: Array<{ id: number; error: string }> }> {
  const out = { done: 0, failed: [] as Array<{ id: number; error: string }> };
  for (const id of ids) {
    try {
      await decideReview(pool, id, decision);
      out.done++;
    } catch (err) {
      out.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

async function listReviewById(pool: pg.Pool, id: number): Promise<ReviewItem | null> {
  const { rows } = await pool.query(
    `select rq.id, rq.item_type, rq.proposal, rq.reason, rq.status, rq.created_at, rq.decided_at,
            i.id as interaction_id, i.title, i.occurred_at, i.workspace_id, pa.id as party_id, pa.name as party_name, pr.id as project_id, pr.name as project_name
     from review_queue rq
     left join interactions i on i.id = rq.interaction_id
     left join parties pa on pa.id = nullif(rq.proposal->>'party_id', '')::bigint
     left join projects pr on pr.id = nullif(rq.proposal->>'project_id', '')::bigint
     where rq.id = $1`,
    [id],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

type Applier = (db: pg.PoolClient, proposal: Record<string, unknown>, row: Record<string, unknown>) => Promise<string[]>;

/** Re-validates a stored proposal (the shapes are the propose_update tool's) and strips the bookkeeping fields. */
function shape<T extends ProposalType>(type: T, proposal: Record<string, unknown>): Record<string, unknown> {
  const { source: _s, proposed_by: _b, token_id: _t, proposed_at: _a, model: _m, evidence: _e, ...rest } = proposal;
  const parsed = PROPOSAL_SCHEMAS[type].safeParse(rest);
  if (!parsed.success) throw new ReviewError(400, `proposal no longer matches the ${type} shape: ${parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"} ${i.message}`).join("; ")}`);
  return parsed.data as Record<string, unknown>;
}

const SINGULAR = { parties: "party", interactions: "interaction", projects: "project" } as const;

async function mustExist(db: pg.PoolClient, table: "parties" | "interactions" | "projects", id: unknown): Promise<void> {
  const { rowCount } = await db.query(`select 1 from ${table} where id = $1`, [id]);
  if (!rowCount) throw new ReviewError(400, `unknown ${SINGULAR[table]} ${String(id)}`);
}

function uniqueList(existing: unknown, add: unknown): string[] {
  const out: string[] = [];
  for (const v of [...((existing as string[] | null) ?? []), ...((add as string[] | undefined) ?? [])]) {
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/**
 * An unknown texter or emailer was approved as a party: their stored messages now point at it
 * (segments.speaker_party_id where the message came from that identifier) and every thread they
 * are in lists them as a participant. Workspaces are not re-routed; inbox threads keep their own
 * workspace_assignment review rows.
 */
export async function linkMessageSender(db: pg.PoolClient, partyId: number, identifier: string, name: string): Promise<string[]> {
  const threads = await db.query<{ id: number }>(
    `select id from interactions where kind in ('text_thread', 'email_thread') and participants_raw @> $1::jsonb`,
    [JSON.stringify([{ identifier }])],
  );
  const ids = threads.rows.map((r) => Number(r.id));
  if (!ids.length) return [];
  const seg = await db.query(
    `update segments s set speaker_party_id = $2
       from interactions i cross join lateral jsonb_array_elements(i.source_payload->'messages') m
      where i.id = any($1::bigint[]) and s.interaction_id = i.id and (m->>'idx')::int = s.idx and m->>'from' = $3 and s.speaker_party_id is null`,
    [ids, partyId, identifier],
  );
  for (const id of ids) {
    await db.query(`insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values ($1, $2, $3, 1) on conflict (interaction_id, party_id) do nothing`, [id, partyId, name]);
  }
  await db.query(
    `update interactions set participants_raw = (
        select jsonb_agg(case when e->>'identifier' = $2 then jsonb_set(e, '{party_id}', to_jsonb($3::bigint)) else e end) from jsonb_array_elements(participants_raw) e)
      where id = any($1::bigint[])`,
    [ids, identifier, partyId],
  );
  return [`interaction_participants (${ids.length} thread(s))`, `segments.speaker_party_id (${seg.rowCount ?? 0} message(s))`];
}

const APPLIERS: Record<ProposalType, Applier> = {
  async new_party(db, raw, row) {
    const p = shape("new_party", raw);
    const handles = (p.handles as string[] | undefined) ?? [];
    const ins = handles.length
      ? await db.query<{ id: number }>(`insert into parties (kind, name, emails, phones, handles, location, website, notes) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [
          p.kind,
          p.name,
          p.emails ?? [],
          p.phones ?? [],
          handles,
          p.location ?? null,
          p.website ?? null,
          p.notes ?? null,
        ])
      : // Before migration 0011 there is no handles column: a party without handles still saves.
        await db.query<{ id: number }>(`insert into parties (kind, name, emails, phones, location, website, notes) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [
          p.kind,
          p.name,
          p.emails ?? [],
          p.phones ?? [],
          p.location ?? null,
          p.website ?? null,
          p.notes ?? null,
        ]);
    const partyId = ins.rows[0].id;
    const out = [`parties #${partyId}`];
    const evidence = raw.evidence as { identifier?: unknown } | undefined;
    if (raw.source === "messages" && typeof evidence?.identifier === "string") out.push(...(await linkMessageSender(db, partyId, evidence.identifier, p.name as string)));
    const role = p.role as { workspace_id: string; role: string; market?: string; detail?: string } | undefined;
    if (role) {
      const ws = await db.query(`select 1 from workspaces where id = $1`, [role.workspace_id]);
      if (!ws.rowCount) throw new ReviewError(400, `unknown workspace ${role.workspace_id}`);
      await db.query(`insert into roles (workspace_id, party_id, role, market, detail, source_interaction_id) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`, [
        role.workspace_id,
        partyId,
        role.role,
        role.market ?? null,
        role.detail ?? null,
        row.interaction_id ?? null,
      ]);
      out.push(`roles (${role.workspace_id} ${role.role})`);
    }
    return out;
  },

  async party_edit(db, raw) {
    const p = shape("party_edit", raw);
    const changes = p.changes as Record<string, unknown>;
    const { rows } = await db.query(`select * from parties where id = $1 for update`, [p.party_id]);
    if (!rows[0]) throw new ReviewError(400, `unknown party ${String(p.party_id)}`);
    // Emails and phones are added to what is there, never replaced: an agent sees one recording, not the whole record.
    const sets: string[] = [];
    const params: unknown[] = [p.party_id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (changes.name !== undefined) set("name", changes.name);
    if (changes.emails !== undefined) set("emails", uniqueList(rows[0].emails, changes.emails));
    if (changes.phones !== undefined) set("phones", uniqueList(rows[0].phones, changes.phones));
    if (changes.handles !== undefined) set("handles", uniqueList(rows[0].handles ?? [], changes.handles));
    for (const col of ["location", "website", "notes"]) if (changes[col] !== undefined) set(col, changes[col]);
    await db.query(`update parties set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
    return [`parties #${String(p.party_id)} (${Object.keys(changes).join(", ")})`];
  },

  async link_party_interaction(db, raw) {
    const p = shape("link_party_interaction", raw);
    await mustExist(db, "parties", p.party_id);
    await mustExist(db, "interactions", p.interaction_id);
    const label = (p.speaker_label as string | undefined) ?? null;
    await db.query(
      `insert into interaction_participants (interaction_id, party_id, speaker_label, confidence)
       values ($1, $2, $3, $4)
       on conflict (interaction_id, party_id) do update
         set speaker_label = coalesce(excluded.speaker_label, interaction_participants.speaker_label),
             confidence = greatest(coalesce(interaction_participants.confidence, 0), coalesce(excluded.confidence, 0))`,
      [p.interaction_id, p.party_id, label, (p.confidence as number | undefined) ?? 1],
    );
    const out = ["interaction_participants"];
    if (label) {
      const res = await db.query(`update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and speaker_party_id is null`, [p.interaction_id, p.party_id, label]);
      out.push(`segments.speaker_party_id (${res.rowCount ?? 0} lines)`);
    }
    return out;
  },

  async link_project_interaction(db, raw) {
    const p = shape("link_project_interaction", raw);
    await mustExist(db, "projects", p.project_id);
    await mustExist(db, "interactions", p.interaction_id);
    await db.query(`insert into interaction_links (interaction_id, project_id) values ($1, $2) on conflict do nothing`, [p.interaction_id, p.project_id]);
    return [`interaction_links (project #${String(p.project_id)})`];
  },

  async new_fact(db, raw, row) {
    const p = shape("new_fact", raw);
    const { rows } = await db.query<{ workspace_id: string | null }>(`select workspace_id from interactions where id = $1`, [p.interaction_id]);
    if (!rows[0]) throw new ReviewError(400, `unknown interaction ${String(p.interaction_id)}`);
    for (const k of ["owner_party_id", "about_party_id"]) if (p[k] !== undefined) await mustExist(db, "parties", p[k]);
    if (p.project_id !== undefined) await mustExist(db, "projects", p.project_id);
    const ins = await db.query<{ id: number }>(
      `insert into facts (interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, project_id, amount, due_date, status, confidence, quote_start_sec, source_review_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12) returning id`,
      [
        p.interaction_id,
        (p.workspace_id as string | undefined) ?? rows[0].workspace_id,
        p.kind,
        p.text,
        p.owner_party_id ?? null,
        p.about_party_id ?? null,
        p.project_id ?? null,
        p.amount ?? null,
        p.due_date ?? null,
        p.confidence ?? null,
        p.quote_start_sec ?? null,
        row.id,
      ],
    );
    return [`facts #${ins.rows[0].id}`];
  },

  async new_relationship(db, raw) {
    const p = shape("new_relationship", raw);
    await mustExist(db, "parties", p.from_party_id);
    await mustExist(db, "parties", p.to_party_id);
    const ws = (p.workspace_id as string | undefined) ?? null;
    // The unique constraint treats a null workspace as distinct, so look the edge up explicitly.
    const seen = await db.query<{ id: number }>(`select id from relationships where from_party_id = $1 and to_party_id = $2 and kind = $3 and workspace_id is not distinct from $4 for update`, [
      p.from_party_id,
      p.to_party_id,
      p.kind,
      ws,
    ]);
    if (seen.rows[0]) {
      await db.query(`update relationships set evidence_count = coalesce(evidence_count, 0) + 1, last_seen = now(), notes = coalesce(notes, $2) where id = $1`, [seen.rows[0].id, p.notes ?? null]);
      return [`relationships #${seen.rows[0].id} (evidence +1)`];
    }
    const ins = await db.query<{ id: number }>(
      `insert into relationships (from_party_id, to_party_id, kind, workspace_id, first_seen, last_seen, evidence_count, notes) values ($1, $2, $3, $4, now(), now(), 1, $5) returning id`,
      [p.from_party_id, p.to_party_id, p.kind, ws, p.notes ?? null],
    );
    return [`relationships #${ins.rows[0].id}`];
  },
};
