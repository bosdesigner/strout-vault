// Workspace scope: what a token may see. Stored on the token as a JSON array of workspace
// ids, or ["*"] for every workspace except the restricted ones, or ["*", "phalanx"] to
// include one. phalanx holds investor material, personal holds family texts and email, and
// inbox holds messages nobody has filed yet (which could be either); none of them is ever
// implied by "*". Every query the MCP server runs ends in `scopeSql(...)`, including the
// vector search.
import type pg from "pg";

export type StoredScope = string[];

/** Workspaces that "*" never includes unless they are listed explicitly. */
export const RESTRICTED_WORKSPACES = ["phalanx", "personal", "inbox"] as const;

/**
 * Restricted workspaces the consent screen ticks by default (Phase 1 v2): Ben's own connector reads
 * his personal texts and notes. phalanx and inbox are never ticked by default and never implied by "*".
 */
export const CONNECTOR_DEFAULT_RESTRICTED = ["personal"] as const;

/** Why each restricted workspace is restricted, for the consent screen and the Agents page. */
export const RESTRICTED_NOTES: Record<string, string> = {
  phalanx: "Investor material: not included unless you tick it.",
  personal: "Family and personal texts, email and notes. Ticked for your own connector; untick it for anyone else's.",
  inbox: "Items the classifier could not file confidently (borderline Phalanx material waits here too): not included unless you tick it.",
};

/**
 * Pseudo-workspace for recordings that have no workspace_id yet (the Zoom sync never set one).
 * Like phalanx it must be listed explicitly: "*" never implies it, because an unassigned recording
 * could belong to any venture, investor material included.
 */
export const UNASSIGNED = "unassigned";

export interface ResolvedScope {
  /** Concrete workspace ids the token may read. Empty means nothing at all. */
  ids: string[];
  /** True when "*" was in the stored scope (shown in the UI; enforcement always uses `ids`). */
  all: boolean;
  /** True when the token may also read recordings whose workspace_id is null. */
  unassigned: boolean;
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
  const unassigned = stored.includes(UNASSIGNED);
  const explicit = stored.filter((s) => s !== "*" && s !== UNASSIGNED);
  let ids: string[];
  if (all) {
    const known = knownWorkspaces ?? (await pool.query(`select id from workspaces order by id`)).rows.map((r) => r.id as string);
    ids = known.filter((id) => !(RESTRICTED_WORKSPACES as readonly string[]).includes(id) || explicit.includes(id));
    for (const id of explicit) if (!ids.includes(id) && known.includes(id)) ids.push(id);
  } else {
    ids = explicit;
  }
  return { ids, all, unassigned, stored };
}

/**
 * SQL predicate restricting `column` (a workspace_id) to the scope. Appends its parameter
 * to `params`. An empty scope yields "false": a token with no workspaces sees nothing.
 * Rows whose workspace_id is null are in scope only when the token lists "unassigned".
 */
export function scopeSql(scope: ResolvedScope, params: unknown[], column = "i.workspace_id"): string {
  const parts: string[] = [];
  if (scope.ids.length) {
    params.push(scope.ids);
    parts.push(`${column} = any($${params.length}::text[])`);
  }
  if (scope.unassigned) parts.push(`${column} is null`);
  if (!parts.length) return "false";
  return parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`;
}

export function inScope(scope: ResolvedScope, workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return scope.unassigned;
  return scope.ids.includes(workspaceId);
}

export function describeScope(stored: StoredScope): string {
  if (!stored.length) return "no workspaces";
  const all = stored.includes("*");
  const unassigned = stored.includes(UNASSIGNED);
  const extra = stored.filter((s) => s !== "*" && s !== UNASSIGNED);
  const tail = unassigned ? " + unassigned recordings" : "";
  if (all) return (extra.length ? `all workspaces incl. ${extra.join(", ")}` : `all workspaces except ${RESTRICTED_WORKSPACES.join(", ")}`) + tail;
  return (extra.join(", ") || "no workspaces") + tail;
}
