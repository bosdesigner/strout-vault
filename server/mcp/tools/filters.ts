// Shared WHERE-clause builder for interaction lists and searches: scope first, then the
// optional workspace/party/project/date filters. Every tool that touches interactions uses it.
import { inScope, scopeSql, UNASSIGNED } from "../scope.ts";
import { ToolError, type ToolContext } from "./types.ts";

export interface InteractionFilters {
  workspace?: string;
  party_id?: number;
  project_id?: number;
  since?: string;
  until?: string;
}

export interface BuiltWhere {
  where: string;
  params: unknown[];
  p: (v: unknown) => string;
  /** True when a requested workspace is outside the scope: the caller returns an empty result with a note. */
  outOfScope: boolean;
}

export function interactionWhere(ctx: ToolContext, f: InteractionFilters, alias = "i"): BuiltWhere {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = [scopeSql(ctx.scope, params, `${alias}.workspace_id`)];
  let outOfScope = false;
  if (f.workspace === UNASSIGNED) {
    // Recordings that have no workspace yet; readable only by tokens that list "unassigned".
    if (!ctx.scope.unassigned) outOfScope = true;
    conds.push(`${alias}.workspace_id is null`);
  } else if (f.workspace) {
    if (!inScope(ctx.scope, f.workspace)) outOfScope = true;
    conds.push(`${alias}.workspace_id = ${p(f.workspace)}`);
  }
  if (f.party_id) conds.push(`exists (select 1 from interaction_participants ip where ip.interaction_id = ${alias}.id and ip.party_id = ${p(f.party_id)})`);
  if (f.project_id) conds.push(`exists (select 1 from interaction_links il where il.interaction_id = ${alias}.id and il.project_id = ${p(f.project_id)})`);
  if (f.since) conds.push(`${alias}.occurred_at >= ${p(parseDate(f.since, "since"))}::timestamptz`);
  if (f.until) conds.push(`${alias}.occurred_at < ${p(parseDate(f.until, "until"))}::timestamptz`);
  return { where: conds.join(" and "), params, p, outOfScope };
}

export function parseDate(v: string, name: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new ToolError("invalid_argument", `${name} must be YYYY-MM-DD or an ISO 8601 timestamp`);
  return d.toISOString();
}

/** Scope note for a workspace the token cannot read: say so plainly instead of returning nothing silently. */
export function outOfScopeNote(ctx: ToolContext, workspace: string): string {
  const have = [...ctx.scope.ids, ...(ctx.scope.unassigned ? [UNASSIGNED] : [])];
  return `workspace "${workspace}" is not within this token's scope (${have.join(", ") || "no workspaces"}); no results`;
}
