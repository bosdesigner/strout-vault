// The steps that reverse an applied proposal. The appliers in services/review.ts record one step per
// row they write; undoing replays them last-first in one transaction. Only the tables and columns
// an applier writes are allowed here, so a stored step can never reach anything else.
import type pg from "pg";

export type UndoOp =
  | { op: "delete"; table: DeleteTable; where: Record<string, number> }
  | { op: "restore"; table: RestoreTable; where: Record<string, number>; values: Record<string, unknown> }
  | { op: "array_remove"; table: "parties"; id: number; column: "emails" | "phones"; values: string[] }
  | { op: "segments_unassign"; ids: number[]; party_id: number }
  | { op: "participants_raw_unset"; interaction_ids: number[]; identifier: string; party_id: number };

type DeleteTable = "parties" | "roles" | "interaction_participants" | "interaction_links" | "facts" | "fact_sources" | "relationships";
type RestoreTable = "parties" | "interaction_participants" | "facts" | "relationships";

const DELETE_KEYS: Record<DeleteTable, string[]> = {
  parties: ["id"],
  roles: ["party_id", "id"],
  interaction_participants: ["interaction_id", "party_id"],
  interaction_links: ["interaction_id", "project_id"],
  facts: ["id"],
  fact_sources: ["fact_id", "interaction_id"],
  relationships: ["id"],
};
const RESTORE_COLUMNS: Record<RestoreTable, { keys: string[]; columns: string[] }> = {
  parties: { keys: ["id"], columns: ["name", "location", "website", "notes"] },
  interaction_participants: { keys: ["interaction_id", "party_id"], columns: ["speaker_label", "confidence"] },
  facts: { keys: ["id"], columns: ["due_date", "amount", "project_id", "about_party_id"] },
  relationships: { keys: ["id"], columns: ["evidence_count", "last_seen", "notes"] },
};

export class UndoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function whereClause(allowed: string[], where: Record<string, number>, params: unknown[]): string {
  const keys = Object.keys(where);
  if (!keys.length || keys.some((k) => !allowed.includes(k))) throw new UndoError(400, `undo step has an unexpected key (${keys.join(", ")})`);
  return keys
    .map((k) => {
      params.push(where[k]);
      return `${k} = $${params.length}`;
    })
    .join(" and ");
}

/** Replays the steps last-first inside the caller's transaction. A row that something else now points at stops the undo (409). */
export async function runUndo(db: pg.PoolClient, ops: UndoOp[]): Promise<string[]> {
  const done: string[] = [];
  for (const op of [...ops].reverse()) {
    const params: unknown[] = [];
    if (op.op === "delete") {
      if (!(op.table in DELETE_KEYS)) throw new UndoError(400, `undo cannot delete from ${op.table}`);
      const sql = `delete from ${op.table} where ${whereClause(DELETE_KEYS[op.table], op.where, params)}`;
      await db.query("savepoint undo_step");
      try {
        const r = await db.query(sql, params);
        done.push(`deleted ${op.table} ${JSON.stringify(op.where)}${r.rowCount ? "" : " (already gone)"}`);
        await db.query("release savepoint undo_step");
      } catch (err) {
        await db.query("rollback to savepoint undo_step");
        if ((err as { code?: string }).code === "23503") {
          throw new UndoError(409, `cannot undo: ${op.table} ${JSON.stringify(op.where)} is now used elsewhere (${(err as { detail?: string }).detail ?? "a later record points at it"}). Change that record first, or fix this one by hand.`);
        }
        throw err;
      }
    } else if (op.op === "restore") {
      const spec = RESTORE_COLUMNS[op.table];
      if (!spec) throw new UndoError(400, `undo cannot restore ${op.table}`);
      const cols = Object.keys(op.values).filter((c) => spec.columns.includes(c));
      if (!cols.length) continue;
      const sets = cols.map((c) => {
        params.push(op.values[c]);
        return `${c} = $${params.length}`;
      });
      await db.query(`update ${op.table} set ${sets.join(", ")} where ${whereClause(spec.keys, op.where, params)}`, params);
      done.push(`restored ${op.table} ${JSON.stringify(op.where)} (${cols.join(", ")})`);
    } else if (op.op === "array_remove") {
      if (op.table !== "parties" || !["emails", "phones"].includes(op.column)) throw new UndoError(400, "undo cannot change that column");
      await db.query(
        `update parties set ${op.column} = coalesce((select array_agg(v order by o) from unnest(${op.column}) with ordinality as t(v, o) where lower(v) <> all ($2::text[])), '{}'), updated_at = now() where id = $1`,
        [op.id, op.values.map((v) => v.toLowerCase())],
      );
      done.push(`removed ${op.values.join(", ")} from parties #${op.id} ${op.column}`);
    } else if (op.op === "segments_unassign") {
      if (!op.ids.length) continue;
      const r = await db.query(`update segments set speaker_party_id = null where id = any($1::bigint[]) and speaker_party_id = $2`, [op.ids, op.party_id]);
      done.push(`unassigned ${r.rowCount ?? 0} line(s)`);
    } else if (op.op === "participants_raw_unset") {
      await db.query(
        `update interactions set participants_raw = (
            select jsonb_agg(case when e->>'identifier' = $2 and (e->>'party_id')::bigint = $3 then e - 'party_id' else e end order by o)
              from jsonb_array_elements(participants_raw) with ordinality as t(e, o))
          where id = any($1::bigint[])`,
        [op.interaction_ids, op.identifier, op.party_id],
      );
      done.push(`unlinked ${op.identifier} on ${op.interaction_ids.length} thread(s)`);
    } else {
      throw new UndoError(400, `unknown undo step ${(op as { op: string }).op}`);
    }
  }
  return done;
}
