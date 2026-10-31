import type pg from "pg";
import { recordFact } from "../facts/store.ts";
import { z } from "zod";
import { PROPOSAL_SCHEMAS, type ProposalType } from "../mcp/tools/propose.ts";
import type { UndoOp } from "./undo.ts";

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
  /** owner | auto | undo (null on items decided before v0.14). */
  decidedBy: string | null;
  /** The auto-apply rules' verdict ({auto, rule, reasons, ...}) when they have looked at the item. */
  route: Record<string, unknown> | null;
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
    `select rq.*, i.id as interaction_id, i.title, i.occurred_at, i.workspace_id,
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
    decidedBy: (r.decided_by as string | null | undefined) ?? null,
    route: (r.route as Record<string, unknown> | null | undefined) ?? null,
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
      } else if (row.item_type in FOLLOWTHROUGH_APPLIERS) {
        // The follow-through step's proposals (Jarvis step 5 C).
        applied.push(...(await FOLLOWTHROUGH_APPLIERS[row.item_type](client, proposal, row)));
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
      (await hasDecidedBy(client)) ? `update review_queue set status = $2, decided_at = now(), decided_by = 'owner' where id = $1 returning *` : `update review_queue set status = $2, decided_at = now() where id = $1 returning *`,
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

let decidedByColumn: boolean | null = null;
/** review_queue.decided_by arrives with 0014; before it is applied, decisions are written as before. */
async function hasDecidedBy(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  if (decidedByColumn === null) {
    const { rowCount } = await db.query(`select 1 from information_schema.columns where table_name = 'review_queue' and column_name = 'decided_by' and table_schema = current_schema()`);
    decidedByColumn = !!rowCount;
  }
  return decidedByColumn;
}

export async function listReviewById(pool: pg.Pool | pg.PoolClient, id: number): Promise<ReviewItem | null> {
  const { rows } = await pool.query(
    `select rq.*, i.id as interaction_id, i.title, i.occurred_at, i.workspace_id, pa.id as party_id, pa.name as party_name, pr.id as project_id, pr.name as project_name
     from review_queue rq
     left join interactions i on i.id = rq.interaction_id
     left join parties pa on pa.id = nullif(rq.proposal->>'party_id', '')::bigint
     left join projects pr on pr.id = nullif(rq.proposal->>'project_id', '')::bigint
     where rq.id = $1`,
    [id],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

/**
 * Applies one proposal inside the caller's transaction. When `undo` is given, every row written is
 * recorded there as the step that reverses it (services/undo.ts replays them last-first); the
 * auto-apply path passes it, the Review page's approve does not need to.
 */
export type Applier = (db: pg.PoolClient, proposal: Record<string, unknown>, row: Record<string, unknown>, undo?: UndoOp[]) => Promise<string[]>;

/** Re-validates a stored proposal (the shapes are the propose_update tool's) and strips the bookkeeping fields. */
function shape<T extends ProposalType>(type: T, proposal: Record<string, unknown>): Record<string, unknown> {
  const { source: _s, proposed_by: _b, token_id: _t, proposed_at: _a, model: _m, evidence: _e, source_quote: _q, ...rest } = proposal;
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
async function linkMessageSender(db: pg.PoolClient, partyId: number, identifier: string, name: string, undo?: UndoOp[]): Promise<string[]> {
  const threads = await db.query<{ id: number }>(
    `select id from interactions where kind in ('text_thread', 'email_thread') and participants_raw @> $1::jsonb`,
    [JSON.stringify([{ identifier }])],
  );
  const ids = threads.rows.map((r) => Number(r.id));
  if (!ids.length) return [];
  const seg = await db.query<{ id: number }>(
    `update segments s set speaker_party_id = $2
       from interactions i cross join lateral jsonb_array_elements(i.source_payload->'messages') m
      where i.id = any($1::bigint[]) and s.interaction_id = i.id and (m->>'idx')::int = s.idx and m->>'from' = $3 and s.speaker_party_id is null
      returning s.id`,
    [ids, partyId, identifier],
  );
  undo?.push({ op: "segments_unassign", ids: seg.rows.map((r) => Number(r.id)), party_id: partyId });
  for (const id of ids) {
    const ins = await db.query(`insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values ($1, $2, $3, 1) on conflict (interaction_id, party_id) do nothing`, [id, partyId, name]);
    if (ins.rowCount) undo?.push({ op: "delete", table: "interaction_participants", where: { interaction_id: id, party_id: partyId } });
  }
  undo?.push({ op: "participants_raw_unset", interaction_ids: ids, identifier, party_id: partyId });
  await db.query(
    `update interactions set participants_raw = (
        select jsonb_agg(case when e->>'identifier' = $2 then jsonb_set(e, '{party_id}', to_jsonb($3::bigint)) else e end) from jsonb_array_elements(participants_raw) e)
      where id = any($1::bigint[])`,
    [ids, identifier, partyId],
  );
  return [`interaction_participants (${ids.length} thread(s))`, `segments.speaker_party_id (${seg.rowCount ?? 0} message(s))`];
}

export const APPLIERS: Record<ProposalType, Applier> = {
  async new_party(db, raw, row, undo) {
    const p = shape("new_party", raw);
    const ins = await db.query<{ id: number }>(`insert into parties (kind, name, emails, phones, location, website, notes) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [
      p.kind,
      p.name,
      p.emails ?? [],
      p.phones ?? [],
      p.location ?? null,
      p.website ?? null,
      p.notes ?? null,
    ]);
    const partyId = Number(ins.rows[0].id);
    // Pushed first, so it is replayed last: everything that points at the party goes before it.
    undo?.push({ op: "delete", table: "parties", where: { id: partyId } });
    const out = [`parties #${partyId}`];
    const evidence = raw.evidence as { identifier?: unknown } | undefined;
    if (raw.source === "messages" && typeof evidence?.identifier === "string") out.push(...(await linkMessageSender(db, partyId, evidence.identifier, p.name as string, undo)));
    const role = p.role as { workspace_id: string; role: string; market?: string; detail?: string } | undefined;
    if (role) {
      const ws = await db.query(`select 1 from workspaces where id = $1`, [role.workspace_id]);
      if (!ws.rowCount) throw new ReviewError(400, `unknown workspace ${role.workspace_id}`);
      undo?.push({ op: "delete", table: "roles", where: { party_id: partyId } });
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

  async party_edit(db, raw, _row, undo) {
    const p = shape("party_edit", raw);
    const changes = p.changes as Record<string, unknown>;
    const { rows } = await db.query(`select emails, phones from parties where id = $1 for update`, [p.party_id]);
    if (!rows[0]) throw new ReviewError(400, `unknown party ${String(p.party_id)}`);
    // Emails and phones are added to what is there, never replaced: an agent sees one recording, not the whole record.
    const sets: string[] = [];
    const params: unknown[] = [p.party_id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const before = await db.query(`select name, location, website, notes from parties where id = $1`, [p.party_id]);
    const restore: Record<string, unknown> = {};
    if (changes.name !== undefined) {
      set("name", changes.name);
      restore.name = before.rows[0].name;
    }
    for (const col of ["emails", "phones"] as const) {
      if (changes[col] === undefined) continue;
      const merged = uniqueList(rows[0][col], changes[col]);
      set(col, merged);
      const added = merged.slice(((rows[0][col] as string[] | null) ?? []).length);
      if (added.length) undo?.push({ op: "array_remove", table: "parties", id: Number(p.party_id), column: col, values: added });
    }
    for (const col of ["location", "website", "notes"]) {
      if (changes[col] === undefined) continue;
      set(col, changes[col]);
      restore[col] = before.rows[0][col];
    }
    if (Object.keys(restore).length) undo?.push({ op: "restore", table: "parties", where: { id: Number(p.party_id) }, values: restore });
    await db.query(`update parties set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
    return [`parties #${String(p.party_id)} (${Object.keys(changes).join(", ")})`];
  },

  async link_party_interaction(db, raw, _row, undo) {
    const p = shape("link_party_interaction", raw);
    await mustExist(db, "parties", p.party_id);
    await mustExist(db, "interactions", p.interaction_id);
    const label = (p.speaker_label as string | undefined) ?? null;
    const prior = await db.query(`select speaker_label, confidence from interaction_participants where interaction_id = $1 and party_id = $2`, [p.interaction_id, p.party_id]);
    const key = { interaction_id: Number(p.interaction_id), party_id: Number(p.party_id) };
    undo?.push(prior.rows[0] ? { op: "restore", table: "interaction_participants", where: key, values: { speaker_label: prior.rows[0].speaker_label, confidence: prior.rows[0].confidence } } : { op: "delete", table: "interaction_participants", where: key });
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
      const res = await db.query<{ id: number }>(`update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and speaker_party_id is null returning id`, [p.interaction_id, p.party_id, label]);
      undo?.push({ op: "segments_unassign", ids: res.rows.map((r) => Number(r.id)), party_id: Number(p.party_id) });
      out.push(`segments.speaker_party_id (${res.rowCount ?? 0} lines)`);
    }
    return out;
  },

  async link_project_interaction(db, raw, _row, undo) {
    const p = shape("link_project_interaction", raw);
    await mustExist(db, "projects", p.project_id);
    await mustExist(db, "interactions", p.interaction_id);
    const ins = await db.query(`insert into interaction_links (interaction_id, project_id) values ($1, $2) on conflict do nothing`, [p.interaction_id, p.project_id]);
    if (ins.rowCount) undo?.push({ op: "delete", table: "interaction_links", where: { interaction_id: Number(p.interaction_id), project_id: Number(p.project_id) } });
    return [ins.rowCount ? `interaction_links (project #${String(p.project_id)})` : `interaction_links (project #${String(p.project_id)} already linked)`];
  },

  async new_fact(db, raw, row, undo) {
    const p = shape("new_fact", raw);
    const { rows } = await db.query<{ workspace_id: string | null }>(`select workspace_id from interactions where id = $1`, [p.interaction_id]);
    if (!rows[0]) throw new ReviewError(400, `unknown interaction ${String(p.interaction_id)}`);
    for (const k of ["owner_party_id", "about_party_id"]) if (p[k] !== undefined) await mustExist(db, "parties", p[k]);
    if (p.project_id !== undefined) await mustExist(db, "projects", p.project_id);
    // One write path for facts: a repeat of an open fact links this conversation to it instead (fact_sources).
    const quote = (typeof raw.source_quote === "string" ? raw.source_quote : null) ?? (typeof row.reason === "string" ? (row.reason.match(/^“(.+)” at /)?.[1] ?? null) : null);
    const r = await recordFact(db, {
      interactionId: p.interaction_id as number,
      workspaceId: (p.workspace_id as string | undefined) ?? rows[0].workspace_id,
      kind: p.kind as string,
      text: p.text as string,
      ownerPartyId: (p.owner_party_id as number | undefined) ?? null,
      aboutPartyId: (p.about_party_id as number | undefined) ?? null,
      projectId: (p.project_id as number | undefined) ?? null,
      amount: (p.amount as number | undefined) ?? null,
      dueDate: (p.due_date as string | undefined) ?? null,
      confidence: (p.confidence as number | undefined) ?? null,
      quote,
      quoteStartSec: (p.quote_start_sec as number | undefined) ?? null,
      origin: "review",
      sourceReviewId: row.id as number,
    });
    if (r.created) undo?.push({ op: "delete", table: "facts", where: { id: r.factId } });
    else {
      if (r.previous) undo?.push({ op: "restore", table: "facts", where: { id: r.factId }, values: r.previous });
      if (r.sourceAdded) undo?.push({ op: "delete", table: "fact_sources", where: { fact_id: r.factId, interaction_id: Number(p.interaction_id) } });
    }
    return [r.created ? `facts #${r.factId}` : `facts #${r.factId} (already recorded; this conversation added as a source)`];
  },

  async new_relationship(db, raw, _row, undo) {
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
      const prev = await db.query(`select evidence_count, last_seen, notes from relationships where id = $1`, [seen.rows[0].id]);
      undo?.push({ op: "restore", table: "relationships", where: { id: Number(seen.rows[0].id) }, values: prev.rows[0] });
      await db.query(`update relationships set evidence_count = coalesce(evidence_count, 0) + 1, last_seen = now(), notes = coalesce(notes, $2) where id = $1`, [seen.rows[0].id, p.notes ?? null]);
      return [`relationships #${seen.rows[0].id} (evidence +1)`];
    }
    const ins = await db.query<{ id: number }>(
      `insert into relationships (from_party_id, to_party_id, kind, workspace_id, first_seen, last_seen, evidence_count, notes) values ($1, $2, $3, $4, now(), now(), 1, $5) returning id`,
      [p.from_party_id, p.to_party_id, p.kind, ws, p.notes ?? null],
    );
    undo?.push({ op: "delete", table: "relationships", where: { id: Number(ins.rows[0].id) } });
    return [`relationships #${ins.rows[0].id}`];
  },
};

// ---- Follow-through (Jarvis step 5 C, docs/FOLLOW-THROUGH.md) ----

const DraftShape = z.object({ channel: z.enum(["email", "text"]), to: z.string().min(1), subject: z.string().nullable().optional(), body: z.string().min(1) });
const FactStatusShape = z.object({ fact_id: z.coerce.number().int().positive(), status: z.enum(["done", "dropped"]), interaction_id: z.coerce.number().int().positive().optional() });

/**
 * fact_status closes the commitment (status done or dropped, when, and the conversation that showed it).
 * reply_needed and nudge change no record: approving means Ben is handling it (he sends the draft
 * himself; step D turns approval into a Gmail draft). Rejecting any of them just closes the item.
 */
const FOLLOWTHROUGH_APPLIERS: Record<string, Applier> = {
  async fact_status(db, raw) {
    const parsed = FactStatusShape.safeParse(raw);
    if (!parsed.success) throw new ReviewError(400, "proposal no longer matches the fact_status shape");
    const p = parsed.data;
    const { rows } = await db.query<{ status: string }>(`select status from facts where id = $1 for update`, [p.fact_id]);
    if (!rows[0]) throw new ReviewError(400, `unknown fact ${p.fact_id}`);
    if (rows[0].status !== "open") throw new ReviewError(400, `fact ${p.fact_id} is already ${rows[0].status}`);
    await db.query(`update facts set status = $2, closed_at = now(), closed_by_interaction_id = $3 where id = $1`, [p.fact_id, p.status, p.interaction_id ?? null]);
    return [`facts #${p.fact_id} ${p.status}`];
  },
  async reply_needed() {
    return ["handled (send the draft yourself)"];
  },
  async nudge() {
    return ["handled (send the draft yourself)"];
  },
};

/** Edits the draft on an open reply_needed or nudge item; the edited text is what Ben (or step D) sends. */
export async function updateDraft(pool: pg.Pool, id: number, edit: { subject?: string | null; body: string }): Promise<ReviewItem> {
  const { rows } = await pool.query(`select item_type, status, proposal from review_queue where id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new ReviewError(404, "review item not found");
  if (row.status !== "open") throw new ReviewError(409, `already ${row.status}`);
  const draft = (row.proposal as Record<string, unknown>).draft;
  const current = DraftShape.safeParse(draft);
  if (!current.success) throw new ReviewError(400, "this item has no draft to edit");
  const next = { ...current.data, body: edit.body, ...(edit.subject !== undefined && current.data.channel === "email" ? { subject: edit.subject } : {}), edited: true };
  await pool.query(`update review_queue set proposal = jsonb_set(proposal, '{draft}', $2::jsonb) where id = $1`, [id, JSON.stringify(next)]);
  return (await listReviewById(pool, id))!;
}
