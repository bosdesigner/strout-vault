// list_leads: every lead (platform, funnel and Airtable), one entry per person, with where they
// came from, their stage, the last conversation with them and what is still open.
import { z } from "zod";
import { inScope, scopeSql } from "../scope.ts";
import { outOfScopeNote, parseDate } from "./filters.ts";
import { limitArg, workspaceArg } from "./schemas.ts";
import { clampLimit, deepLink, iso, type ToolDef } from "./types.ts";

const CLOSED = ["dead", "converted", "archived", "lost", "client"];

const schema = {
  workspace: workspaceArg,
  lead_type: z.enum(["homeowner", "contractor", "other"]).optional().describe("Only homeowner leads (renovation clients) or contractor leads (franchise / network recruits)."),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD or an ISO timestamp").optional().describe("Only people whose latest lead came in on or after this date."),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD or an ISO timestamp")
    .optional()
    .describe("Only people whose latest lead came in before this date or time (exclusive). To page back through a long list, pass the oldest latest_submission of the previous page."),
  needs_follow_up: z
    .boolean()
    .optional()
    .describe("Only open leads (not dead, converted or archived) with no recorded conversation since their latest lead came in. The 'who have I not talked to yet' list."),
  query: z.string().trim().min(2).max(200).optional().describe("Name, email, phone, address or company contains this."),
  limit: limitArg,
};

export const listLeads: ToolDef<typeof schema> = {
  name: "list_leads",
  title: "List leads",
  description:
    "List leads (people who asked about a project or about joining the network), newest first, one entry per person across every source: the platform's lead table, the website funnel, and the Airtable Client Pipeline intake. " +
    "Each entry has contact details, homeowner or contractor, every submission with its source, stage and status, the last recorded conversation with them, how many days since they came in or were last talked to, and open commitments. " +
    "Use it for 'which leads came in this week', 'who haven't I called back' (needs_follow_up) or 'what do we know about the Mayfield lead', then get_party for the full profile.",
  inputSchema: schema,
  readOnly: true,
  async run(args, ctx) {
    if (args.workspace && !inScope(ctx.scope, args.workspace)) {
      return { result: { count: 0, note: outOfScopeNote(ctx, args.workspace), items: [] }, count: 0 };
    }
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conds = ["lr.party_id is not null", scopeSql(ctx.scope, params, "lr.workspace_id")];
    if (args.workspace) conds.push(`lr.workspace_id = ${p(args.workspace)}`);
    if (args.lead_type) conds.push(`lr.lead_type = ${p(args.lead_type)}`);
    if (args.query) {
      const q = p(`%${args.query.replace(/[%_\\]/g, "\\$&")}%`);
      conds.push(`(pa.name ilike ${q} or lr.email ilike ${q} or lr.phone ilike ${q} or lr.address ilike ${q} or lr.company ilike ${q})`);
    }
    const having: string[] = [];
    if (args.since) having.push(`max(lr.submitted_at) >= ${p(parseDate(args.since, "since"))}`);
    if (args.until) having.push(`max(lr.submitted_at) < ${p(parseDate(args.until, "until"))}`);
    if (args.needs_follow_up) {
      having.push(`not (lower(coalesce((array_agg(lr.status order by lr.submitted_at desc nulls last))[1], '')) = any(${p(CLOSED)}::text[]))`);
      having.push(`coalesce(max(conv.occurred_at), 'epoch') < coalesce(max(lr.submitted_at), now())`);
    }
    const inter = scopeSql(ctx.scope, params, "i.workspace_id");
    const limit = clampLimit(args.limit);
    const { rows } = await ctx.reader.query(
      `with conv as (
         select ip.party_id, i.id, i.title, i.occurred_at, row_number() over (partition by ip.party_id order by i.occurred_at desc nulls last, i.id desc) as rn
           from interaction_participants ip join interactions i on i.id = ip.interaction_id where ${inter}
       )
       select pa.id as party_id, pa.name, pa.emails, pa.phones, pa.location,
              (array_agg(lr.lead_type order by lr.submitted_at desc nulls last))[1] as lead_type,
              min(lr.submitted_at) as first_seen, max(lr.submitted_at) as latest,
              jsonb_agg(jsonb_build_object('origin', lr.origin, 'channel', lr.channel, 'stage', lr.stage, 'status', lr.status, 'submitted_at', lr.submitted_at,
                                           'address', lr.address, 'market', lr.market, 'notes', left(lr.notes, 500), 'details', lr.details)
                        order by lr.submitted_at desc nulls last) as submissions,
              max(conv.occurred_at) as last_conversation_at,
              (array_agg(conv.id) filter (where conv.id is not null))[1] as last_conversation_id,
              (array_agg(conv.title) filter (where conv.id is not null))[1] as last_conversation_title,
              (select count(*)::int from facts f where (f.owner_party_id = pa.id or f.about_party_id = pa.id) and coalesce(f.status, 'open') = 'open') as open_facts
         from lead_records lr
         join parties pa on pa.id = lr.party_id
         left join conv on conv.party_id = pa.id and conv.rn = 1
        where ${conds.join(" and ")}
        group by pa.id
        ${having.length ? `having ${having.join(" and ")}` : ""}
        order by max(lr.submitted_at) desc nulls last, pa.id desc
        limit ${limit}`,
      params,
    );
    const now = ctx.now().getTime();
    const days = (d: unknown) => (d ? Math.floor((now - new Date(d as string).getTime()) / 86_400_000) : null);
    const items = rows.map((r) => {
      const lastTouch = r.last_conversation_at && (!r.latest || new Date(r.last_conversation_at) > new Date(r.latest)) ? r.last_conversation_at : null;
      return {
        party_id: r.party_id,
        name: r.name,
        emails: r.emails ?? [],
        phones: r.phones ?? [],
        location: r.location,
        lead_type: r.lead_type,
        first_seen: iso(r.first_seen),
        latest_submission: iso(r.latest),
        days_since_latest: days(r.latest),
        submissions: (r.submissions as Array<Record<string, unknown>>).slice(0, 10),
        last_conversation: r.last_conversation_id
          ? { interaction_id: r.last_conversation_id, title: r.last_conversation_title, occurred_at: iso(r.last_conversation_at), deep_link: deepLink(ctx, `/r/${r.last_conversation_id}`) }
          : null,
        talked_since_latest_submission: !!lastTouch,
        open_facts: r.open_facts,
        deep_link: deepLink(ctx, `/p/${r.party_id}`),
      };
    });
    return { result: { count: items.length, items }, count: items.length };
  },
};
