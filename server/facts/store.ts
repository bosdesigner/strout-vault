// One place that writes a fact (Phase 1 v2). The extractor, review approval and the backfill all
// call recordFact(): it either creates an open fact or, when the same promise is already recorded
// (the model said so with same_as_fact_id, or an open fact of the same kind, owner and workspace
// reads the same), links this conversation to that fact in fact_sources instead. Every fact has at
// least one fact_sources row, so "where was this said" is always answerable.
import type pg from "pg";

export interface FactInput {
  interactionId: number;
  workspaceId: string | null;
  kind: string;
  text: string;
  ownerPartyId?: number | null;
  aboutPartyId?: number | null;
  projectId?: number | null;
  amount?: number | null;
  dueDate?: string | null;
  confidence?: number | null;
  quote?: string | null;
  quoteStartSec?: number | null;
  messageIdx?: number | null;
  /** extract | review | backfill */
  origin: string;
  sourceReviewId?: number | null;
  /** The model's same_as_fact_id: an open fact this one repeats. */
  sameAs?: number | null;
}

/** Trigram similarity at which two open facts of the same kind and owner are the same promise. */
export const SAME_FACT_SIMILARITY = 0.55;
/** How far apart (days) two mentions of one promise may be. */
const SAME_FACT_WINDOW_DAYS = 45;

export interface RecordResult {
  factId: number;
  created: boolean;
  /** Joined an existing fact: whether this conversation's fact_sources row is new, and the fact's fill-in columns before this mention. */
  sourceAdded?: boolean;
  previous?: { due_date: string | null; amount: string | null; project_id: number | null; about_party_id: number | null };
}

type Db = pg.Pool | pg.PoolClient;

/** The open fact `f` repeats, if any: the model's pick (validated), else the closest same-kind, same-owner open fact. */
export async function findSameFact(db: Db, f: FactInput): Promise<number | null> {
  if (f.sameAs) {
    const { rows } = await db.query(`select id from facts where id = $1 and status = 'open' and workspace_id is not distinct from $2`, [f.sameAs, f.workspaceId]);
    if (rows[0]) return Number(rows[0].id);
  }
  const { rows } = await db.query(
    `select f.id, similarity(f.text, $1) as sim
       from facts f
      where f.status = 'open' and f.kind = $2 and f.workspace_id is not distinct from $3
        and f.owner_party_id is not distinct from $4
        and ($5::bigint is null or f.about_party_id is null or f.about_party_id = $5)
        and f.created_at > now() - make_interval(days => $6)
        and f.text % $1
      order by sim desc limit 1`,
    [f.text, f.kind, f.workspaceId, f.ownerPartyId ?? null, f.aboutPartyId ?? null, SAME_FACT_WINDOW_DAYS],
  );
  return rows[0] && Number(rows[0].sim) >= SAME_FACT_SIMILARITY ? Number(rows[0].id) : null;
}

export async function recordFact(db: Db, f: FactInput): Promise<RecordResult> {
  const same = await findSameFact(db, f);
  if (same) {
    const before = await db.query(`select to_char(due_date, 'YYYY-MM-DD') as due_date, amount::text as amount, project_id, about_party_id from facts where id = $1`, [same]);
    const src = await db.query(
      `insert into fact_sources (fact_id, interaction_id, quote, quote_start_sec, message_idx, confidence) values ($1, $2, $3, $4, $5, $6)
       on conflict (fact_id, interaction_id) do nothing`,
      [same, f.interactionId, f.quote ?? null, f.quoteStartSec ?? null, f.messageIdx ?? null, f.confidence ?? null],
    );
    // A later mention can fill in what the first one lacked.
    await db.query(
      `update facts set due_date = coalesce(due_date, $2), amount = coalesce(amount, $3), project_id = coalesce(project_id, $4), about_party_id = coalesce(about_party_id, $5) where id = $1`,
      [same, f.dueDate ?? null, f.amount ?? null, f.projectId ?? null, f.aboutPartyId ?? null],
    );
    const b = before.rows[0] ?? {};
    return {
      factId: same,
      created: false,
      sourceAdded: (src.rowCount ?? 0) > 0,
      previous: { due_date: b.due_date ?? null, amount: b.amount ?? null, project_id: b.project_id == null ? null : Number(b.project_id), about_party_id: b.about_party_id == null ? null : Number(b.about_party_id) },
    };
  }
  const ins = await db.query<{ id: number }>(
    `insert into facts (interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, project_id, amount, due_date, status, confidence, quote_start_sec, quote, message_idx, origin, source_review_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12, $13, $14, $15) returning id`,
    [
      f.interactionId,
      f.workspaceId,
      f.kind,
      f.text,
      f.ownerPartyId ?? null,
      f.aboutPartyId ?? null,
      f.projectId ?? null,
      f.amount ?? null,
      f.dueDate ?? null,
      f.confidence ?? null,
      f.quoteStartSec ?? null,
      f.quote ?? null,
      f.messageIdx ?? null,
      f.origin,
      f.sourceReviewId ?? null,
    ],
  );
  const factId = Number(ins.rows[0].id);
  await db.query(`insert into fact_sources (fact_id, interaction_id, quote, quote_start_sec, message_idx, confidence) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`, [
    factId,
    f.interactionId,
    f.quote ?? null,
    f.quoteStartSec ?? null,
    f.messageIdx ?? null,
    f.confidence ?? null,
  ]);
  return { factId, created: true };
}

export class FactError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Closes (done | dropped) or reopens a fact. Returns the updated row. */
export async function setFactStatus(pool: pg.Pool, id: number, status: "done" | "dropped" | "open", byInteractionId?: number | null): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    status === "open"
      ? `update facts set status = 'open', closed_at = null, closed_by_interaction_id = null where id = $1 returning *`
      : `update facts set status = $2, closed_at = now(), closed_by_interaction_id = $3 where id = $1 returning *`,
    status === "open" ? [id] : [id, status, byInteractionId ?? null],
  );
  if (!rows[0]) throw new FactError(404, "fact not found");
  // A done-check the follow-through step queued for this fact is moot now.
  if (status !== "open") await pool.query(`update review_queue set status = 'approved', decided_at = now() where item_type = 'fact_status' and status = 'open' and (proposal->>'fact_id')::bigint = $1`, [id]);
  return rows[0];
}
