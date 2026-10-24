// get_party: a person or organisation and everything the scope lets the token see about them.
import { z } from "zod";
import { scopeSql } from "../scope.ts";
import { clampLimit, dateOnly, deepLink, iso, ToolError, type ToolContext, type ToolDef } from "./types.ts";

const schema = {
  id: z.coerce.number().int().positive().optional().describe("Party id, when known (from search results, get_interaction participants or an earlier get_party)."),
  name: z.string().min(1).max(200).optional().describe("Person or company name, or part of one. Fuzzy: 'kevin', 'McGuire' and 'Kevin McGuire' all work. Ambiguous matches return candidates instead of a profile."),
  email: z.string().min(3).max(200).optional().describe("An email address on file for the party."),
  phone: z.string().min(3).max(50).optional().describe("A phone number on file; digits only are compared."),
};

/**
 * Parties the scope can see: anyone with a role in a scoped workspace, who took part in a
 * scoped interaction, or who is on a scoped project. Appends to params; use as a subquery.
 */
export function visiblePartySql(ctx: ToolContext, params: unknown[], alias = "p"): string {
  if (!ctx.scope.ids.length) return "false";
  const roles = scopeSql(ctx.scope, params, "r.workspace_id");
  const inter = scopeSql(ctx.scope, params, "i.workspace_id");
  const proj = scopeSql(ctx.scope, params, "pr.workspace_id");
  return `(
    exists (select 1 from roles r where r.party_id = ${alias}.id and ${roles})
    or exists (select 1 from interaction_participants ip join interactions i on i.id = ip.interaction_id where ip.party_id = ${alias}.id and ${inter})
    or exists (select 1 from project_parties pp join projects pr on pr.id = pp.project_id where pp.party_id = ${alias}.id and ${proj})
  )`;
}

export const getParty: ToolDef<typeof schema> = {
  name: "get_party",
  title: "Get a person or company",
  description:
    "Look up a person or organisation by id, name (fuzzy), email or phone and return their profile: contact fields, affiliations (person ↔ company), roles by workspace (client, contractor, vendor, investor…), relationships, projects, the last 10 interactions they took part in, and facts about them or owned by them. " +
    "When a name matches several people the result has `ambiguous: true` and a `candidates` list: pick one and call again with its id. Only what the token's workspace scope allows is returned. Includes a deep_link to the person's page.",
  inputSchema: schema,
  readOnly: true,
  async run(args, ctx) {
    if (!args.id && !args.name && !args.email && !args.phone) throw new ToolError("invalid_argument", "give one of id, name, email or phone");
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const visible = visiblePartySql(ctx, params);
    let where: string;
    let order = "p.name";
    if (args.id) where = `p.id = ${p(args.id)}`;
    else if (args.email) where = `exists (select 1 from unnest(p.emails) e where lower(e) = lower(${p(args.email.trim())}))`;
    else if (args.phone) {
      // Digits only, and the last ten digits decide when both sides have at least ten (country codes vary).
      const q = p(args.phone);
      where = `exists (select 1 from unnest(p.phones) ph, regexp_replace(ph, '\\D', '', 'g') as d1, regexp_replace(${q}, '\\D', '', 'g') as d2
                 where d1 <> '' and (d1 = d2 or (length(d1) >= 10 and length(d2) >= 10 and right(d1, 10) = right(d2, 10))))`;
    }
    else {
      const term = p(args.name!.trim());
      where = `(p.name ilike '%' || ${term} || '%' or similarity(p.name, ${term}) > 0.3)`;
      order = `(lower(p.name) = lower(${term})) desc, similarity(p.name, ${term}) desc, p.name`;
    }
    const { rows } = await ctx.reader.query(
      `select p.id, p.kind, p.name, p.emails, p.location,
              ${args.name ? `similarity(p.name, ${p(args.name.trim())})` : "1.0"} as sim
         from parties p where ${where} and ${visible} order by ${order} limit 6`,
      params,
    );
    if (!rows.length) throw new ToolError("not_found", "no matching party within this token's scope");
    if (rows.length > 1 && args.name) {
      const exact = rows.filter((r) => r.name.toLowerCase() === args.name!.trim().toLowerCase());
      const clear = exact.length === 1 ? exact[0] : Number(rows[0].sim) - Number(rows[1].sim) >= 0.25 ? rows[0] : null;
      if (!clear) {
        return {
          result: {
            ambiguous: true,
            query: args.name,
            candidates: rows.slice(0, 5).map((r) => ({ party_id: r.id, name: r.name, kind: r.kind, location: r.location, emails: r.emails ?? [], similarity: Number(Number(r.sim).toFixed(2)) })),
          },
          count: Math.min(rows.length, 5),
        };
      }
      return { result: await profile(ctx, clear.id), count: 1 };
    }
    return { result: await profile(ctx, rows[0].id), count: 1 };
  },
};

async function profile(ctx: ToolContext, id: number): Promise<Record<string, unknown>> {
  const sp = (col: string) => {
    const params: unknown[] = [id];
    return { sql: scopeSql(ctx.scope, params, col), params };
  };
  const roles = sp("r.workspace_id");
  const inter = sp("i.workspace_id");
  const proj = sp("pr.workspace_id");
  const facts = sp("coalesce(f.workspace_id, i.workspace_id)");
  const rel = sp("rel.workspace_id");
  const affParams: unknown[] = [id];
  const affVisible = visiblePartySql(ctx, affParams, "o");
  const [party, rolesQ, aff, inters, projects, factsQ, rels] = await Promise.all([
    ctx.reader.query(`select id, kind, name, emails, phones, location, website, notes, created_at, updated_at from parties where id = $1`, [id]),
    ctx.reader.query(
      `select r.workspace_id, w.name as workspace_name, r.role, r.status, r.market, r.detail, r.started_at, r.ended_at
         from roles r join workspaces w on w.id = r.workspace_id where r.party_id = $1 and ${roles.sql} order by w.name, r.role`,
      roles.params,
    ),
    ctx.reader.query(
      `select a.title, a.is_current, o.id as other_id, o.name as other_name, o.kind as other_kind,
              case when a.person_id = $1 then 'works_at' else 'employs' end as direction
         from affiliations a join parties o on o.id = case when a.person_id = $1 then a.org_id else a.person_id end
        where (a.person_id = $1 or a.org_id = $1) and ${affVisible} order by a.is_current desc, o.name`,
      affParams,
    ),
    ctx.reader.query(
      `select i.id, i.title, i.kind, i.source, i.occurred_at, i.duration_sec, i.workspace_id, ip.speaker_label
         from interaction_participants ip join interactions i on i.id = ip.interaction_id
        where ip.party_id = $1 and ${inter.sql} order by i.occurred_at desc nulls last, i.id desc limit 10`,
      inter.params,
    ),
    ctx.reader.query(
      `select pr.id, pr.name, pr.status, pr.workspace_id, pp.role from project_parties pp join projects pr on pr.id = pp.project_id
        where pp.party_id = $1 and ${proj.sql} order by pr.name limit 50`,
      proj.params,
    ),
    ctx.reader.query(
      `select f.id, f.kind, f.text, f.status, f.amount, f.due_date, f.quote_start_sec, f.confidence, f.interaction_id, f.project_id,
              f.owner_party_id, f.about_party_id, i.title as interaction_title, i.occurred_at
         from facts f left join interactions i on i.id = f.interaction_id
        where (f.owner_party_id = $1 or f.about_party_id = $1) and ${facts.sql}
        order by (f.status = 'open') desc, f.due_date nulls last, f.id desc limit ${clampLimit(50)}`,
      facts.params,
    ),
    ctx.reader.query(
      `select rel.kind, rel.workspace_id, rel.first_seen, rel.last_seen, rel.evidence_count, rel.notes,
              case when rel.from_party_id = $1 then 'from' else 'to' end as direction,
              o.id as other_id, o.name as other_name, o.kind as other_kind
         from relationships rel join parties o on o.id = case when rel.from_party_id = $1 then rel.to_party_id else rel.from_party_id end
        where (rel.from_party_id = $1 or rel.to_party_id = $1) and ${rel.sql} order by rel.last_seen desc nulls last limit 50`,
      rel.params,
    ),
  ]);
  const pr = party.rows[0];
  return {
    party_id: pr.id,
    kind: pr.kind,
    name: pr.name,
    emails: pr.emails ?? [],
    phones: pr.phones ?? [],
    location: pr.location,
    website: pr.website,
    notes: pr.notes,
    affiliations: aff.rows.map((a) => ({ party_id: a.other_id, name: a.other_name, kind: a.other_kind, title: a.title, is_current: a.is_current, direction: a.direction })),
    roles: rolesQ.rows.map((r) => ({ workspace_id: r.workspace_id, workspace: r.workspace_name, role: r.role, status: r.status, market: r.market, detail: r.detail, started_at: dateOnly(r.started_at), ended_at: dateOnly(r.ended_at) })),
    relationships: rels.rows.map((r) => ({ kind: r.kind, direction: r.direction, party_id: r.other_id, name: r.other_name, party_kind: r.other_kind, workspace_id: r.workspace_id, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), evidence_count: r.evidence_count, notes: r.notes })),
    projects: projects.rows.map((p) => ({ project_id: p.id, name: p.name, status: p.status, workspace_id: p.workspace_id, role: p.role, deep_link: deepLink(ctx, `/projects/${p.id}`) })),
    recent_interactions: inters.rows.map((i) => ({ interaction_id: i.id, title: i.title, kind: i.kind, source: i.source, occurred_at: iso(i.occurred_at), duration_sec: i.duration_sec, workspace_id: i.workspace_id, speaker_label: i.speaker_label, deep_link: deepLink(ctx, `/r/${i.id}`) })),
    facts: factsQ.rows.map((f) => ({
      fact_id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      amount: f.amount,
      due_date: dateOnly(f.due_date),
      confidence: f.confidence,
      role: f.owner_party_id === id ? "owner" : "about",
      project_id: f.project_id,
      interaction: f.interaction_id ? { interaction_id: f.interaction_id, title: f.interaction_title, occurred_at: iso(f.occurred_at), quote_start_sec: f.quote_start_sec, deep_link: deepLink(ctx, `/r/${f.interaction_id}${f.quote_start_sec != null ? `?t=${f.quote_start_sec}` : ""}`) } : null,
    })),
    deep_link: deepLink(ctx, `/p/${pr.id}`),
  };
}
