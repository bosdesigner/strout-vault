// The Leads page: one row per person who came in as a lead, newest first, with where they came
// from, their stage and status, and whether anyone has talked to them since.
import type pg from "pg";

export interface LeadPerson {
  partyId: number;
  name: string;
  email: string | null;
  phone: string | null;
  leadType: string;
  latestAt: string | null;
  firstAt: string | null;
  submissions: number;
  origins: string[];
  channel: string | null;
  stage: string | null;
  status: string | null;
  address: string | null;
  lastConversation: { id: number; title: string | null; occurredAt: string | null } | null;
  talkedSince: boolean;
  openFacts: number;
}

export const CLOSED_STATUSES = ["dead", "converted", "archived", "lost", "client"];

export async function listLeadPeople(
  pool: pg.Pool,
  f: { workspaceId?: string | null; leadType?: string | null; followUp?: boolean; q?: string | null; limit?: number },
): Promise<{ items: LeadPerson[]; counts: { total: number; last7: number; needsFollowUp: number } }> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ["lr.party_id is not null"];
  if (f.workspaceId) where.push(`lr.workspace_id = ${p(f.workspaceId)}`);
  if (f.leadType) where.push(`lr.lead_type = ${p(f.leadType)}`);
  if (f.q) {
    const q = p(`%${f.q.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(pa.name ilike ${q} or lr.email ilike ${q} or lr.phone ilike ${q} or lr.address ilike ${q})`);
  }
  const closed = p(CLOSED_STATUSES);
  const { rows } = await pool.query(
    `with conv as (
       select ip.party_id, i.id, i.title, i.occurred_at, row_number() over (partition by ip.party_id order by i.occurred_at desc nulls last, i.id desc) as rn
         from interaction_participants ip join interactions i on i.id = ip.interaction_id
     ), people as (
       select pa.id as party_id, pa.name, pa.emails[1] as email, pa.phones[1] as phone,
              (array_agg(lr.lead_type order by lr.submitted_at desc nulls last))[1] as lead_type,
              max(lr.submitted_at) as latest_at, min(lr.submitted_at) as first_at, count(*)::int as submissions,
              array_agg(distinct lr.origin) as origins,
              (array_agg(lr.channel order by lr.submitted_at desc nulls last))[1] as channel,
              (array_agg(lr.stage order by lr.submitted_at desc nulls last) filter (where lr.stage is not null))[1] as stage,
              (array_agg(lr.status order by lr.submitted_at desc nulls last) filter (where lr.status is not null))[1] as status,
              (array_agg(lr.address order by lr.submitted_at desc nulls last) filter (where lr.address is not null))[1] as address,
              max(conv.id) as conv_id, max(conv.title) as conv_title, max(conv.occurred_at) as conv_at,
              (select count(*)::int from facts fa where (fa.owner_party_id = pa.id or fa.about_party_id = pa.id) and coalesce(fa.status, 'open') = 'open') as open_facts
         from lead_records lr join parties pa on pa.id = lr.party_id
         left join conv on conv.party_id = pa.id and conv.rn = 1
        where ${where.join(" and ")}
        group by pa.id
     )
     select *, (conv_at is not null and conv_at >= coalesce(latest_at, 'epoch')) as talked_since,
            (not (lower(coalesce(status, '')) = any(${closed}::text[])) and not (conv_at is not null and conv_at >= coalesce(latest_at, 'epoch'))) as needs_follow_up,
            count(*) over () as total,
            count(*) filter (where latest_at >= now() - interval '7 days') over () as last7,
            count(*) filter (where not (lower(coalesce(status, '')) = any(${closed}::text[])) and not (conv_at is not null and conv_at >= coalesce(latest_at, 'epoch'))) over () as follow_ups
       from people`,
    params,
  );
  const counts = { total: Number(rows[0]?.total ?? 0), last7: Number(rows[0]?.last7 ?? 0), needsFollowUp: Number(rows[0]?.follow_ups ?? 0) };
  const items = rows
    .filter((r) => !f.followUp || r.needs_follow_up)
    .sort((a, b) => new Date(b.latest_at ?? 0).getTime() - new Date(a.latest_at ?? 0).getTime())
    .slice(0, Math.min(Math.max(f.limit ?? 300, 1), 1000))
    .map((r) => ({
      partyId: Number(r.party_id),
      name: r.name,
      email: r.email ?? null,
      phone: r.phone ?? null,
      leadType: r.lead_type,
      latestAt: r.latest_at ? new Date(r.latest_at).toISOString() : null,
      firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
      submissions: r.submissions,
      origins: r.origins,
      channel: r.channel,
      stage: r.stage,
      status: r.status,
      address: r.address,
      lastConversation: r.conv_id ? { id: Number(r.conv_id), title: r.conv_title, occurredAt: r.conv_at ? new Date(r.conv_at).toISOString() : null } : null,
      talkedSince: !!r.talked_since,
      openFacts: r.open_facts,
    }));
  return { items, counts };
}
