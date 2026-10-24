// Workspace scope: what a token may see. Stored on the token as a JSON array of workspace
// ids, or ["*"] for every workspace except the restricted ones, or ["*", "phalanx"] to
// include one. phalanx holds investor material and is never implied by "*". Every query
// the MCP server runs ends in `scopeSql(...)`, including the vector search.
import type pg from "pg";

export type StoredScope = string[];

/** Workspaces that "*" never includes unless they are listed explicitly. */
export const RESTRICTED_WORKSPACES = ["phalanx"] as const;

export interface ResolvedScope {
  /** Concrete workspace ids the token may read. Empty means nothing at all. */
  ids: string[];
  /** True when "*" was in the stored scope (shown in the UI; enforcement always uses `ids`). */
  all: boolean;
  stored: StoredScope;
}

const WS_ID = /^[a-z0-9_-]{1,100}$/;

/** Validates a scope as stored in jsonb or sent by the tokens page. Throws on junk. */
export function parseStoredScope(value: unknown): StoredScope {
  if (!Array.isArray(value)) throw new Error("workspace scope must be an array of workspace ids");
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !(v === "*" || WS_ID.test(v))) throw new Error(`bad workspace id in scope: ${String(v).slice(0, 40)}`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Expands "*" against the workspaces table, leaving restricted workspaces out unless listed. */
export async function resolveScope(pool: pg.Pool | pg.PoolClient, stored: StoredScope, knownWorkspaces?: string[]): Promise<ResolvedScope> {
  const all = stored.includes("*");
  const explicit = stored.filter((s) => s !== "*");
  let ids: string[];
  if (all) {
    const known = knownWorkspaces ?? (await pool.query(`select id from workspaces order by id`)).rows.map((r) => r.id as string);
    ids = known.filter((id) => !(RESTRICTED_WORKSPACES as readonly string[]).includes(id) || explicit.includes(id));
    for (const id of explicit) if (!ids.includes(id) && known.includes(id)) ids.push(id);
  } else {
    ids = explicit;
  }
  return { ids, all, stored };
}

/**
 * SQL predicate restricting `column` (a workspace_id) to the scope. Appends its parameter
 * to `params`. An empty scope yields "false": a token with no workspaces sees nothing.
 * Rows whose workspace_id is null are never in scope (they cannot be scoped).
 */
export function scopeSql(scope: ResolvedScope, params: unknown[], column = "i.workspace_id"): string {
  if (!scope.ids.length) return "false";
  params.push(scope.ids);
  return `${column} = any($${params.length}::text[])`;
}

export function inScope(scope: ResolvedScope, workspaceId: string | null | undefined): boolean {
  return !!workspaceId && scope.ids.includes(workspaceId);
}

export function describeScope(stored: StoredScope): string {
  if (!stored.length) return "no workspaces";
  const all = stored.includes("*");
  const extra = stored.filter((s) => s !== "*");
  if (all) return extra.length ? `all workspaces incl. ${extra.join(", ")}` : `all workspaces except ${RESTRICTED_WORKSPACES.join(", ")}`;
  return extra.join(", ");
}
