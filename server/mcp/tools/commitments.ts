// list_open_commitments: open facts of kind commitment / task / follow-up, with their source moment.
import { z } from "zod";
import { inScope, scopeSql, UNASSIGNED } from "../scope.ts";
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
    "List open commitments, tasks and follow-ups extracted from conversations (facts with status open), soonest due first, with who owns each one, who it is about, the project, amount and due date, the verbatim quote, and the recording and timestamp (quote_start_sec) it came from. A promise repeated in several conversations is one item; also_said_in lists the other moments. " +
    "Use it for 'what did we promise', 'what is outstanding with X' or 'what is due this week'. Returns an empty list cleanly while no facts have been extracted yet.",
  inputSchema: schema,
  readOnly: true,
  async run(args, ctx) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const wantsUnassigned = args.workspace === UNASSIGNED;
    if (args.workspace && (wantsUnassigned ? !ctx.scope.unassigned : !inScope(ctx.scope, args.workspace))) {
      return { result: { count: 0, note: outOfScopeNote(ctx, args.workspace), items: [] }, count: 0 };
    }
    const conds = [
      `f.kind = any(${p([...COMMITMENT_KINDS])}::text[])`,
      `coalesce(f.status, 'open') = 'open'`,
      scopeSql(ctx.scope, params, "coalesce(f.workspace_id, i.workspace_id)"),
    ];
    if (wantsUnassigned) conds.push(`coalesce(f.workspace_id, i.workspace_id) is null`);
    else if (args.workspace) conds.push(`coalesce(f.workspace_id, i.workspace_id) = ${p(args.workspace)}`);
    if (args.party_id) conds.push(`(f.owner_party_id = ${p(args.party_id)} or f.about_party_id = ${p(args.party_id)})`);
    if (args.due_before) conds.push(`f.due_date <= ${p(parseDate(args.due_before, "due_before"))}::date`);
    const limit = clampLimit(args.limit);
    const quoteCols = await hasPhase1Columns(ctx);
    const { rows } = await ctx.reader.query(
      `select f.id, f.kind, f.text, f.status, f.amount, f.due_date, f.confidence, f.quote_start_sec, f.created_at,
              ${quoteCols ? "f.quote, f.message_index, f.due_text," : "null as quote, null as message_index, null as due_text,"}
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
    // Other moments the same promise was made (fact_sources, 0013), within the token's scope.
    const others = new Map<number, Array<Record<string, unknown>>>();
    if (quoteCols && rows.length) {
      const sp: unknown[] = [rows.map((r) => r.id)];
      const { rows: src } = await ctx.reader.query(
        `select fs.fact_id, fs.interaction_id, fs.quote, fs.quote_start_sec, fs.message_index, i.title, i.occurred_at
           from fact_sources fs join interactions i on i.id = fs.interaction_id
           join facts f on f.id = fs.fact_id
          where fs.fact_id = any($1::bigint[]) and fs.interaction_id is distinct from f.interaction_id and ${scopeSql(ctx.scope, sp, "i.workspace_id")}
          order by i.occurred_at`,
        sp,
      );
      for (const r of src) {
        const list = others.get(Number(r.fact_id)) ?? [];
        list.push({
          interaction_id: r.interaction_id,
          title: r.title,
          occurred_at: iso(r.occurred_at),
          quote: r.quote,
          quote_start_sec: r.quote_start_sec,
          message_index: r.message_index,
          deep_link: deepLink(ctx, `/r/${r.interaction_id}${r.quote_start_sec != null ? `?t=${r.quote_start_sec}` : ""}`),
        });
        others.set(Number(r.fact_id), list);
      }
    }
    const items = rows.map((f) => ({
      fact_id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status ?? "open",
      amount: f.amount,
      due_date: dateOnly(f.due_date),
      due_text: f.due_text ?? null,
      quote: f.quote ?? null,
      confidence: f.confidence,
      workspace_id: f.workspace_id,
      owner: f.owner_id ? { party_id: f.owner_id, name: f.owner_name } : null,
      about: f.about_id ? { party_id: f.about_id, name: f.about_name } : null,
      project: f.project_id ? { project_id: f.project_id, name: f.project_name, deep_link: deepLink(ctx, `/projects/${f.project_id}`) } : null,
      source: f.interaction_id ? { interaction_id: f.interaction_id, title: f.interaction_title, occurred_at: iso(f.occurred_at), quote_start_sec: f.quote_start_sec, message_index: f.message_index ?? null } : null,
      also_said_in: others.get(Number(f.id)) ?? [],
      deep_link: f.interaction_id ? deepLink(ctx, `/r/${f.interaction_id}${f.quote_start_sec != null ? `?t=${f.quote_start_sec}` : ""}`) : null,
    }));
    return { result: { count: items.length, items }, count: items.length };
  },
};

let phase1Columns: boolean | null = null;
/** facts.quote and fact_sources arrive with 0013; before it is applied the tool answers as it always did. */
async function hasPhase1Columns(ctx: { reader: { query: (q: string) => Promise<{ rows: Array<Record<string, unknown>> }> } }): Promise<boolean> {
  if (phase1Columns) return true;
  const { rows } = await ctx.reader.query(`select 1 from information_schema.columns where table_name = 'facts' and column_name = 'quote' limit 1`);
  phase1Columns = rows.length > 0 && (await ctx.reader.query(`select to_regclass('fact_sources') is not null as ok`)).rows[0]?.ok === true;
  return phase1Columns;
}
