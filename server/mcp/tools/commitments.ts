// list_open_commitments: open facts of kind commitment / task / follow-up, with their source moment.
import { z } from "zod";
import { inScope, scopeSql } from "../scope.ts";
import { parseDate, outOfScopeNote } from "./filters.ts";
import { limitArg, partyIdArg, workspaceArg } from "./schemas.ts";
import { clampLimit, dateOnly, deepLink, iso, type ToolDef } from "./types.ts";

// The facts table's check constraint spells the follow-up kind "followup"; the build spec says
// "follow_up" and also names "task". All four are accepted so nothing is missed either way.
export const COMMITMENT_KINDS = ["commitment", "task", "follow_up", "followup"] as const;

const schema = {
  workspace: workspaceArg,
  party_id: partyIdArg.describe("Only commitments owned by or about this party."),
  due_before: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD").optional().describe("Only commitments due on or before this date (YYYY-MM-DD). Commitments without a due date are included unless this is set."),
  limit: limitArg,
};

export const listOpenCommitments: ToolDef<typeof schema> = {
  name: "list_open_commitments",
  title: "List open commitments",
  description:
    "List open commitments, tasks and follow-ups extracted from conversations (facts with status open), newest due first, with who owns each one, who it is about, the project, amount and due date, and the recording and timestamp (quote_start_sec) it came from. " +
    "Use it for 'what did we promise', 'what is outstanding with X' or 'what is due this week'. Returns an empty list cleanly while no facts have been extracted yet.",
  inputSchema: schema,
  readOnly: true,
  async run(args, ctx) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (args.workspace && !inScope(ctx.scope, args.workspace)) return { result: { count: 0, note: outOfScopeNote(ctx, args.workspace), items: [] }, count: 0 };
    const conds = [
      `f.kind = any(${p([...COMMITMENT_KINDS])}::text[])`,
      `coalesce(f.status, 'open') = 'open'`,
      scopeSql(ctx.scope, params, "coalesce(f.workspace_id, i.workspace_id)"),
    ];
    if (args.workspace) conds.push(`coalesce(f.workspace_id, i.workspace_id) = ${p(args.workspace)}`);
    if (args.party_id) conds.push(`(f.owner_party_id = ${p(args.party_id)} or f.about_party_id = ${p(args.party_id)})`);
    if (args.due_before) conds.push(`f.due_date <= ${p(parseDate(args.due_before, "due_before"))}::date`);
    const limit = clampLimit(args.limit);
    const { rows } = await ctx.reader.query(
      `select f.id, f.kind, f.text, f.status, f.amount, f.due_date, f.confidence, f.quote_start_sec, f.created_at,
              coalesce(f.workspace_id, i.workspace_id) as workspace_id,
              i.id as interaction_id, i.title as interaction_title, i.occurred_at,
              o.id as owner_id, o.name as owner_name, a.id as about_id, a.name as about_name, pr.id as project_id, pr.name as project_name
         from facts f
         left join interactions i on i.id = f.interaction_id
         left join parties o on o.id = f.owner_party_id
         left join parties a on a.id = f.about_party_id
         left join projects pr on pr.id = f.project_id
        where ${conds.join(" and ")}
        order by f.due_date asc nulls last, f.created_at desc, f.id desc limit ${limit}`,
      params,
    );
    const items = rows.map((f) => ({
      fact_id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status ?? "open",
      amount: f.amount,
      due_date: dateOnly(f.due_date),
      confidence: f.confidence,
      workspace_id: f.workspace_id,
      owner: f.owner_id ? { party_id: f.owner_id, name: f.owner_name } : null,
      about: f.about_id ? { party_id: f.about_id, name: f.about_name } : null,
      project: f.project_id ? { project_id: f.project_id, name: f.project_name, deep_link: deepLink(ctx, `/projects/${f.project_id}`) } : null,
      source: f.interaction_id ? { interaction_id: f.interaction_id, title: f.interaction_title, occurred_at: iso(f.occurred_at), quote_start_sec: f.quote_start_sec } : null,
      deep_link: f.interaction_id ? deepLink(ctx, `/r/${f.interaction_id}${f.quote_start_sec != null ? `?t=${f.quote_start_sec}` : ""}`) : null,
    }));
    return { result: { count: items.length, items }, count: items.length };
  },
};
