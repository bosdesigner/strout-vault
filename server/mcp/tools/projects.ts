// get_project: a project with its parties, linked interactions and facts.
import { z } from "zod";
import { inScope, scopeSql } from "../scope.ts";
import { dateOnly, deepLink, iso, ToolError, type ToolContext, type ToolDef } from "./types.ts";

const schema = {
  id: z.coerce.number().int().positive().optional().describe("Project id, when known."),
  name: z.string().min(1).max(200).optional().describe("Project name or part of it (fuzzy). Ambiguous matches return candidates."),
};

export const getProject: ToolDef<typeof schema> = {
  name: "get_project",
  title: "Get a project",
  description:
    "Look up a project (a job, deal or engagement) by id or fuzzy name and return it with its parties and their roles, the recordings linked to it (newest first, up to 20) and its facts (commitments, decisions, prices…). " +
    "Several matches return `ambiguous: true` with candidates. Only projects in the token's workspace scope are visible. Includes a deep_link to the project page.",
  inputSchema: schema,
  readOnly: true,
  async run(args, ctx) {
    if (!args.id && !args.name) throw new ToolError("invalid_argument", "give id or name");
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const scoped = scopeSql(ctx.scope, params, "pr.workspace_id");
    let where: string;
    let order = "pr.name";
    if (args.id) where = `pr.id = ${p(args.id)}`;
    else {
      const term = p(args.name!.trim());
      where = `(pr.name ilike '%' || ${term} || '%' or similarity(pr.name, ${term}) > 0.3 or pr.address ilike '%' || ${term} || '%')`;
      order = `(lower(pr.name) = lower(${term})) desc, similarity(pr.name, ${term}) desc, pr.name`;
    }
    const { rows } = await ctx.reader.query(
      `select pr.id, pr.name, pr.status, pr.address, pr.workspace_id, ${args.name ? `similarity(pr.name, ${p(args.name.trim())})` : "1.0"} as sim
         from projects pr where ${where} and ${scoped} order by ${order} limit 6`,
      params,
    );
    if (!rows.length) throw new ToolError("not_found", "no matching project within this token's scope");
    if (rows.length > 1 && args.name) {
      const exact = rows.filter((r) => r.name.toLowerCase() === args.name!.trim().toLowerCase());
      const clear = exact.length === 1 ? exact[0] : Number(rows[0].sim) - Number(rows[1].sim) >= 0.25 ? rows[0] : null;
      if (!clear) {
        return {
          result: { ambiguous: true, query: args.name, candidates: rows.slice(0, 5).map((r) => ({ project_id: r.id, name: r.name, status: r.status, address: r.address, workspace_id: r.workspace_id })) },
          count: Math.min(rows.length, 5),
        };
      }
      return { result: await detail(ctx, clear.id), count: 1 };
    }
    return { result: await detail(ctx, rows[0].id), count: 1 };
  },
};

async function detail(ctx: ToolContext, id: number): Promise<Record<string, unknown>> {
  const interParams: unknown[] = [id];
  const interScope = scopeSql(ctx.scope, interParams, "i.workspace_id");
  const [pr, parties, inters, facts] = await Promise.all([
    ctx.reader.query(`select pr.*, w.name as workspace_name from projects pr join workspaces w on w.id = pr.workspace_id where pr.id = $1`, [id]),
    ctx.reader.query(
      `select pa.id, pa.kind, pa.name, pa.emails, pp.role from project_parties pp join parties pa on pa.id = pp.party_id where pp.project_id = $1 order by pp.role, pa.name`,
      [id],
    ),
    ctx.reader.query(
      `select i.id, i.title, i.kind, i.source, i.occurred_at, i.duration_sec from interaction_links il join interactions i on i.id = il.interaction_id
        where il.project_id = $1 and ${interScope} order by i.occurred_at desc nulls last, i.id desc limit 20`,
      interParams,
    ),
    ctx.reader.query(
      `select f.id, f.kind, f.text, f.status, f.amount, f.due_date, f.quote_start_sec, f.confidence, f.interaction_id, i.title as interaction_title,
              o.id as owner_id, o.name as owner_name, a.id as about_id, a.name as about_name
         from facts f left join interactions i on i.id = f.interaction_id left join parties o on o.id = f.owner_party_id left join parties a on a.id = f.about_party_id
        where f.project_id = $1 order by (f.status = 'open') desc, f.due_date nulls last, f.id desc limit 50`,
      [id],
    ),
  ]);
  const row = pr.rows[0];
  if (!row || !inScope(ctx.scope, row.workspace_id)) throw new ToolError("not_found", "no matching project within this token's scope");
  return {
    project_id: row.id,
    name: row.name,
    status: row.status,
    address: row.address,
    notes: row.notes,
    workspace_id: row.workspace_id,
    workspace: row.workspace_name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    parties: parties.rows.map((p) => ({ party_id: p.id, kind: p.kind, name: p.name, role: p.role, deep_link: deepLink(ctx, `/p/${p.id}`) })),
    interactions: inters.rows.map((i) => ({ interaction_id: i.id, title: i.title, kind: i.kind, source: i.source, occurred_at: iso(i.occurred_at), duration_sec: i.duration_sec, deep_link: deepLink(ctx, `/r/${i.id}`) })),
    facts: facts.rows.map((f) => ({
      fact_id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      amount: f.amount,
      due_date: dateOnly(f.due_date),
      confidence: f.confidence,
      owner: f.owner_id ? { party_id: f.owner_id, name: f.owner_name } : null,
      about: f.about_id ? { party_id: f.about_id, name: f.about_name } : null,
      interaction: f.interaction_id ? { interaction_id: f.interaction_id, title: f.interaction_title, quote_start_sec: f.quote_start_sec } : null,
    })),
    deep_link: deepLink(ctx, `/projects/${row.id}`),
  };
}
