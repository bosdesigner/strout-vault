// Files Inbox items once their people are known. Texts, email, device items and Meet recordings land
// in `inbox` when nobody on them maps to a workspace. Approving a new person, giving someone a role,
// or linking them to a company changes that; this re-runs the same routing (messages routeThread:
// each known participant's routing rule, else the workspaces they have a role in, directly, through
// a company or on a project; email domains as the fallback) over Inbox items and files every one that
// now maps to exactly one workspace. phalanx is never assigned automatically (noAutoPhalanx). Only
// items still in `inbox` are touched, so nothing a person filed is ever moved. Open
// workspace_assignment items for a filed thread are closed as approved.
import type pg from "pg";
import { INBOX, findOwnerParty, routeThread, type PartyRef } from "../messages/ingest.ts";
import type { OwnerIdentity } from "../messages/identity.ts";
import type { MessageRules } from "../messages/rules.ts";
import { noAutoPhalanx } from "../device/ingest.ts";

export interface RefileSummary {
  checked: number;
  filed: Record<string, number>;
}

export async function refileInbox(pool: pg.Pool, rules: MessageRules, owner: OwnerIdentity, opts: { partyIds?: number[]; limit?: number } = {}): Promise<RefileSummary> {
  const summary: RefileSummary = { checked: 0, filed: {} };
  const known = new Set((await pool.query(`select id from workspaces`)).rows.map((r) => r.id as string));
  if (!known.has(INBOX)) return summary;
  const ownerParty = await findOwnerParty(pool, owner);
  const params: unknown[] = [opts.limit ?? 5000];
  let scope = "";
  if (opts.partyIds?.length) {
    params.push(opts.partyIds);
    scope = `and exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = any($2::bigint[]))`;
  }
  const { rows } = await pool.query(
    `select i.id, i.participants_raw,
            coalesce((select array_agg(ip.party_id) from interaction_participants ip where ip.interaction_id = i.id), '{}') as party_ids
       from interactions i
      where i.workspace_id = '${INBOX}' ${scope}
      order by i.id desc limit $1`,
    params,
  );
  for (const r of rows) {
    summary.checked++;
    const partyIds = (r.party_ids as Array<string | number>).map(Number).filter((id) => id !== ownerParty?.id);
    const emails = ((r.participants_raw ?? []) as Array<{ identifier?: string | null; kind?: string }>)
      .filter((p) => p.kind === "email" && p.identifier)
      .map((p) => String(p.identifier));
    if (!partyIds.length && !emails.length) continue;
    const byEmail = new Map<string, PartyRef>();
    if (emails.length) {
      const m = await pool.query(`select p.id, p.name, lower(trim(e)) as key from parties p cross join lateral unnest(p.emails) e where lower(trim(e)) = any($1::text[])`, [emails]);
      for (const x of m.rows) byEmail.set(x.key, { id: Number(x.id), name: x.name });
    }
    const route = noAutoPhalanx(await routeThread(pool, partyIds, emails, byEmail, rules, known));
    if (route.review || route.workspaceId === INBOX) continue;
    const moved = await pool.query(`update interactions set workspace_id = $2, updated_at = now() where id = $1 and workspace_id = '${INBOX}'`, [r.id, route.workspaceId]);
    if (!moved.rowCount) continue;
    await pool.query(`update media set workspace_id = $2 where interaction_id = $1 and workspace_id = '${INBOX}'`, [r.id, route.workspaceId]);
    await pool.query(`update review_queue set status = 'approved', decided_at = now() where interaction_id = $1 and item_type = 'workspace_assignment' and status = 'open'`, [r.id]);
    summary.filed[route.workspaceId] = (summary.filed[route.workspaceId] ?? 0) + 1;
  }
  return summary;
}
