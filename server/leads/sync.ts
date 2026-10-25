// Mirrors every lead into lead_records and makes sure each one is a party the rest of the vault
// knows: matched by email, then phone, or created, with a `prospect` role in LEADS_WORKSPACE.
// Then it looks for recordings whose title names a lead ("Kaylen Apodaca: AnotherStory
// Assessment") and queues a link_party_interaction proposal for each, so approving one ties the
// call to the lead. Leads are source data, not model guesses, so parties and roles are written
// directly; only the call links go through review.

import type pg from "pg";
import { INTERNAL_EMAIL, type LeadInput, type LeadOrigin } from "./sources.ts";

export interface LeadSyncSummary {
  sources: Record<string, { configured: boolean; read: number; error?: string }>;
  leads: number;
  newLeads: number;
  skippedInternal: number;
  skippedNoContact: number;
  partiesCreated: number;
  partiesMatched: number;
  callLinksQueued: number;
  byOrigin: Record<string, number>;
  dryRun: boolean;
  errors: string[];
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const s = (e ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Last ten digits, so +1 (615) 555-0100 and 615.555.0100 match. Null when it is not a phone number. */
export function normalizePhone(p: string | null | undefined): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function displayName(l: LeadInput): string {
  const name = l.name?.replace(/\s+/g, " ").trim();
  if (name) return name.length > 1 && name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
  if (l.company) return l.company;
  const email = normalizeEmail(l.email);
  return email ?? l.phone ?? "Unnamed lead";
}

async function findParty(db: pg.PoolClient | pg.Pool, email: string | null, phone: string | null): Promise<number | null> {
  if (email) {
    const { rows } = await db.query(`select id from parties where exists (select 1 from unnest(emails) e where lower(trim(e)) = $1) order by id limit 1`, [email]);
    if (rows[0]) return Number(rows[0].id);
  }
  if (phone) {
    const { rows } = await db.query(`select id from parties where exists (select 1 from unnest(phones) p where right(regexp_replace(p, '\\D', '', 'g'), 10) = $1) order by id limit 1`, [phone]);
    if (rows[0]) return Number(rows[0].id);
  }
  return null;
}

export interface SyncOptions {
  workspaceId: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Upserts `inputs` (already read from their sources) and resolves parties. Sources that failed
 * to read are simply absent: nothing is deleted when a source is down.
 */
export async function syncLeads(pool: pg.Pool, inputs: LeadInput[], opts: SyncOptions, summary: LeadSyncSummary): Promise<LeadSyncSummary> {
  const log = opts.log ?? (() => {});
  const ws = await pool.query(`select 1 from workspaces where id = $1`, [opts.workspaceId]);
  if (!ws.rowCount) throw new Error(`LEADS_WORKSPACE "${opts.workspaceId}" is not a workspace`);

  const existing = new Map<string, number | null>();
  for (const r of (await pool.query(`select origin, origin_id, party_id from lead_records`)).rows) existing.set(`${r.origin}:${r.origin_id}`, r.party_id === null ? null : Number(r.party_id));

  // Within one run, the same person in several sources resolves to one party.
  const runParties = new Map<string, number>();
  for (const l of inputs) {
    const email = normalizeEmail(l.email);
    const phone = normalizePhone(l.phone);
    if (l.email && INTERNAL_EMAIL.test(l.email.trim())) {
      summary.skippedInternal++;
      continue;
    }
    if (!email && !phone) {
      summary.skippedNoContact++;
      continue;
    }
    const key = `${l.origin}:${l.originId}`;
    const isNew = !existing.has(key);
    summary.leads++;
    summary.byOrigin[l.origin] = (summary.byOrigin[l.origin] ?? 0) + 1;
    if (isNew) summary.newLeads++;
    if (opts.dryRun) {
      const known = (email && runParties.get(`e:${email}`)) || (phone && runParties.get(`p:${phone}`)) || (await findParty(pool, email, phone));
      if (known) summary.partiesMatched++;
      else {
        summary.partiesCreated++;
        if (email) runParties.set(`e:${email}`, -1);
        if (phone) runParties.set(`p:${phone}`, -1);
      }
      continue;
    }

    const db = await pool.connect();
    try {
      await db.query("begin");
      let partyId = existing.get(key) ?? null;
      const resolving = !partyId; // a re-sync of a known lead is not a new match
      if (!partyId) partyId = (email && runParties.get(`e:${email}`)) || (phone && runParties.get(`p:${phone}`)) || (await findParty(db, email, phone));
      if (partyId) {
        if (resolving) summary.partiesMatched++;
        // Learn the contact details the party does not have yet; never overwrite.
        await db.query(
          `update parties set
             emails = case when $2::text is null or exists (select 1 from unnest(emails) e where lower(trim(e)) = $2) then emails else array_append(coalesce(emails, '{}'), $2) end,
             phones = case when $3::text is null or exists (select 1 from unnest(phones) p where right(regexp_replace(p, '\\D', '', 'g'), 10) = right(regexp_replace($3, '\\D', '', 'g'), 10)) then phones else array_append(coalesce(phones, '{}'), $3) end,
             location = coalesce(location, $4),
             -- A party first seen without a name was named after its email or phone; a real name wins.
             name = case when $5::text is not null and (name ~ '@' or name !~ '[A-Za-z]' or name = 'Unnamed lead') then $5 else name end,
             updated_at = now()
           where id = $1`,
          [partyId, email, phone ? l.phone!.trim() : null, l.address, l.name?.trim() ? displayName(l) : null],
        );
      } else {
        const ins = await db.query<{ id: number }>(
          `insert into parties (kind, name, emails, phones, location, notes) values ('person', $1, $2, $3, $4, $5) returning id`,
          [displayName(l), email ? [email] : [], phone ? [l.phone!.trim()] : [], l.address, `Lead (${l.leadType}) from ${l.channel ?? l.origin}`],
        );
        partyId = Number(ins.rows[0].id);
        summary.partiesCreated++;
      }
      if (email) runParties.set(`e:${email}`, partyId);
      if (phone) runParties.set(`p:${phone}`, partyId);

      await db.query(
        `insert into roles (workspace_id, party_id, role, status, market, detail) values ($1, $2, 'prospect', 'prospect', $3, $4)
         on conflict (workspace_id, party_id, role) do update set market = coalesce(roles.market, excluded.market)`,
        [opts.workspaceId, partyId, l.market, `${l.leadType} lead`],
      );
      await db.query(
        `insert into lead_records (origin, origin_id, party_id, workspace_id, lead_type, name, email, phone, company, address, zip, market, channel, stage, status, notes, details, submitted_at, origin_updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
         on conflict (origin, origin_id) do update set
           party_id = coalesce(lead_records.party_id, excluded.party_id), lead_type = excluded.lead_type, name = excluded.name, email = excluded.email,
           phone = excluded.phone, company = excluded.company, address = excluded.address, zip = excluded.zip, market = excluded.market,
           channel = excluded.channel, stage = excluded.stage, status = excluded.status, notes = excluded.notes, details = excluded.details,
           submitted_at = excluded.submitted_at, origin_updated_at = excluded.origin_updated_at, last_synced_at = now()`,
        [
          l.origin,
          l.originId,
          partyId,
          opts.workspaceId,
          l.leadType,
          l.name,
          email ?? l.email,
          l.phone,
          l.company,
          l.address,
          l.zip,
          l.market,
          l.channel,
          l.stage,
          l.status,
          l.notes,
          JSON.stringify(l.details ?? {}),
          l.submittedAt,
          l.originUpdatedAt,
        ],
      );
      await db.query("commit");
    } catch (err) {
      await db.query("rollback").catch(() => {});
      summary.errors.push(`${key}: ${(err as Error).message.slice(0, 300)}`);
    } finally {
      db.release();
    }
  }
  if (!opts.dryRun) summary.callLinksQueued = await queueCallLinks(pool);
  log(`leads: ${summary.leads} lead(s) (${summary.newLeads} new), ${summary.partiesCreated} new part(ies), ${summary.partiesMatched} matched, ${summary.callLinksQueued} call link(s) queued`);
  return summary;
}

/**
 * Recordings whose title contains a lead's full name (two words or more) and that do not have
 * the lead on them yet: one link_party_interaction proposal each, unless one was already queued
 * or decided for that pair.
 */
export async function queueCallLinks(pool: pg.Pool): Promise<number> {
  const res = await pool.query(
    `insert into review_queue (item_type, proposal, reason, interaction_id, status)
     select 'link_party_interaction',
            jsonb_build_object('party_id', p.id, 'interaction_id', i.id, 'confidence', 0.9, 'source', 'leads', 'proposed_at', now()),
            'The recording title names ' || p.name || ', a lead',
            i.id, 'open'
       from (select distinct party_id from lead_records where party_id is not null) lr
       join parties p on p.id = lr.party_id
       join interactions i on strpos(lower(i.title), lower(p.name)) > 0
      where p.name ~ '\\S+\\s+\\S+' and length(p.name) >= 5 and p.name !~ '@'
        and not exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = p.id)
        and not exists (select 1 from review_queue rq where rq.interaction_id = i.id and rq.item_type in ('link_party_interaction', 'participant_match')
                          and rq.proposal->>'party_id' = p.id::text)`,
  );
  return res.rowCount ?? 0;
}

export function emptySummary(dryRun = false): LeadSyncSummary {
  return { sources: {}, leads: 0, newLeads: 0, skippedInternal: 0, skippedNoContact: 0, partiesCreated: 0, partiesMatched: 0, callLinksQueued: 0, byOrigin: {}, dryRun, errors: [] };
}

export const ORIGIN_LABEL: Record<LeadOrigin, string> = {
  platform_leads: "platform",
  platform_site_leads: "funnel",
  airtable_contact: "Airtable contact",
  airtable_contractor_intake: "Airtable contractor intake",
  airtable_archived: "Airtable archived",
};
