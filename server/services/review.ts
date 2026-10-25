import type pg from "pg";

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
            pa.id as party_id, pa.name as party_name
     from review_queue rq
     left join interactions i on i.id = rq.interaction_id
     left join parties pa on pa.id = nullif(rq.proposal->>'party_id', '')::bigint
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
 * transaction. Other item types are only marked (nothing else to apply yet).
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
      } else if (row.item_type === "interaction_workspace") {
        // Files a recording under a workspace (scripts/propose-workspaces.ts queues these).
        const interactionId = num(proposal.interaction_id) ?? (row.interaction_id as number | null);
        const workspaceId = typeof proposal.workspace_id === "string" ? proposal.workspace_id : null;
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
            i.id as interaction_id, i.title, i.occurred_at, i.workspace_id, pa.id as party_id, pa.name as party_name
     from review_queue rq
     left join interactions i on i.id = rq.interaction_id
     left join parties pa on pa.id = nullif(rq.proposal->>'party_id', '')::bigint
     where rq.id = $1`,
    [id],
  );
  return rows[0] ? toItem(rows[0]) : null;
}
