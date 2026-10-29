// Who was on a recording or call, resolved to parties, and the workspace that follows from it.
// Used by the worker's `resolve` step (new Zoom / Meet recordings and iPhone calls, once they are
// transcribed) and by `npm run resolve:backfill` (everything that came in unlinked or unfiled).
//
// Candidates, strongest first:
//   zoom_api    Zoom's participant list for the meeting (name + email of signed-in participants),
//               when the Zoom app has the scope for it
//   calendar    the matching Google Calendar event's guests (same time window), from a connected
//               Meet account that granted calendar.events.readonly
//   contact     the phone's contact card on an iPhone call / the Meet transcript's speakers
//   title       names in the title ("<Name>: AnotherStory Assessment", "Ben and <Name>", …)
//   transcript  speaker labels in the transcript
//
// Each candidate resolves to a party: by email first (parties.emails, then the email on a lead
// record), then by exact normalized name (party names and lead names). A near miss on the name
// ("Bejamin" vs "Benjamin") is never linked or merged: it becomes a suggested match on Review
// (link_party_interaction). A new party is created only when nothing matches at all, and only for
// an email or a full (two-word) name. Ben is never "the other participant".
//
// Links are written to interaction_participants with resolved_by = the candidate's source, and new
// parties carry external_refs.created_by = 'participant-resolver', so the whole pass can be reverted
// as a set. Then, for an item still unfiled (or in inbox): the title rules, else the people on it
// (the messages routing: exactly one workspace wins, phalanx never) file it.
import type pg from "pg";
import { matchParties, NEVER_AUTO_ASSIGNED, INBOX, routeThread, type PartyRef } from "../messages/ingest.ts";
import { normalizeEmail, normalizeIdentifier, isOwner, type OwnerIdentity } from "../messages/identity.ts";
import type { MessageRules } from "../messages/rules.ts";
import { displayName, isFuzzyNameMatch, isOwnerName, looksLikeName, normalizeName, parseTitleNamesDetailed } from "./names.ts";
import { matchFilingRule, rejectedWorkspaces, WORKSPACE_DECISION_TYPES, type FilingRule } from "../workspaces/filing.ts";

export type CandidateSource = "zoom_api" | "calendar" | "contact" | "title" | "transcript";
export const RESOLVER_TAG = "participant-resolver";

export interface Candidate {
  name: string | null;
  email: string | null;
  phone?: string | null;
  /** Already matched upstream (the device ingest's contact match). */
  partyId?: number | null;
  /** Title names only: the title names this person on purpose ("<Name>: …"), so a new party may be made. */
  strong?: boolean;
  via: CandidateSource;
}

export interface InteractionRow {
  id: number;
  title: string | null;
  source: string | null;
  source_ref: string | null;
  kind: string;
  occurred_at: Date | string | null;
  duration_sec: number | null;
  workspace_id: string | null;
  host_email: string | null;
  participants_raw: Array<Record<string, unknown>> | null;
}

export interface ResolveDeps {
  owner: OwnerIdentity;
  ownerNames: string[];
  rules: MessageRules;
  filingRules: FilingRule[];
  /** Zoom's participant list for a meeting UUID; null when the Zoom app cannot read it. */
  zoomParticipants?: (uuid: string) => Promise<Array<{ name: string | null; email: string | null }> | null>;
  /** Guests of the calendar event at that time; null when no calendar is connected. */
  calendarAttendees?: (start: Date, end: Date, title: string | null) => Promise<Array<{ name: string | null; email: string }> | null>;
}

export interface Linked {
  partyId: number;
  name: string;
  via: CandidateSource;
  how: "email" | "lead_email" | "name" | "lead_name" | "contact" | "phone" | "created";
  isLead: boolean;
}

export interface ResolveResult {
  interactionId: number;
  title: string | null;
  linked: Linked[];
  suggested: Array<{ partyId: number; name: string; candidate: string; via: CandidateSource }>;
  /** Candidates that resolved to nothing and were not created (a first name on its own, an ambiguous name). */
  unresolved: string[];
  workspaceBefore: string | null;
  workspaceAfter: string | null;
  filedBy: string | null;
}

// ---------------------------------------------------------------- party index --

interface IndexedParty {
  id: number;
  name: string;
  isLead: boolean;
  placeholder: boolean;
}

/** Every person and lead the vault knows, by normalized name and email, loaded once per batch. */
export class PartyIndex {
  readonly byName = new Map<string, Set<number>>();
  readonly byEmail = new Map<string, number>();
  readonly parties = new Map<number, IndexedParty>();
  /** Placeholder parties (named after their email): the email's local part, letters only. */
  readonly byLocalPart = new Map<string, number>();

  add(p: { id: number; name: string; emails?: string[] | null; isLead?: boolean }, extraNames: string[] = []): void {
    const placeholder = p.name.includes("@");
    const prev = this.parties.get(p.id);
    this.parties.set(p.id, { id: p.id, name: p.name, isLead: !!p.isLead || !!prev?.isLead, placeholder });
    for (const n of [placeholder ? "" : p.name, ...extraNames]) {
      const key = normalizeName(n);
      if (!key) continue;
      const set = this.byName.get(key) ?? new Set<number>();
      set.add(p.id);
      this.byName.set(key, set);
    }
    for (const e of p.emails ?? []) {
      const key = normalizeEmail(e);
      if (!key) continue;
      if (!this.byEmail.has(key)) this.byEmail.set(key, p.id);
      if (placeholder) this.byLocalPart.set(key.split("@")[0].replace(/[^a-z]/g, ""), p.id);
    }
  }

  static async load(db: pg.Pool | pg.PoolClient): Promise<PartyIndex> {
    const idx = new PartyIndex();
    const [parties, leads] = await Promise.all([
      db.query(`select id, name, emails from parties where kind = 'person' order by id`),
      db.query(`select party_id, name, email from lead_records where party_id is not null`).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
    ]);
    const leadNames = new Map<number, string[]>();
    const leadEmails = new Map<number, string[]>();
    for (const l of leads.rows) {
      const id = Number(l.party_id);
      if (l.name) leadNames.set(id, [...(leadNames.get(id) ?? []), String(l.name)]);
      if (l.email) leadEmails.set(id, [...(leadEmails.get(id) ?? []), String(l.email)]);
    }
    for (const p of parties.rows) {
      const id = Number(p.id);
      idx.add({ id, name: String(p.name), emails: [...((p.emails as string[] | null) ?? []), ...(leadEmails.get(id) ?? [])], isLead: leadNames.has(id) || leadEmails.has(id) }, leadNames.get(id) ?? []);
    }
    return idx;
  }

  /** Exact normalized-name matches. */
  exact(name: string): IndexedParty[] {
    return [...(this.byName.get(normalizeName(name)) ?? [])].map((id) => this.parties.get(id)!).filter(Boolean);
  }

  /** Near misses: typos in a full name, or a placeholder party whose email spells the name. */
  fuzzy(name: string): IndexedParty[] {
    const out = new Map<number, IndexedParty>();
    const n = normalizeName(name);
    if (n.split(" ").length < 2) return [];
    for (const [key, ids] of this.byName) {
      if (!isFuzzyNameMatch(n, key)) continue;
      for (const id of ids) out.set(id, this.parties.get(id)!);
      if (out.size >= 5) break;
    }
    const local = this.byLocalPart.get(n.replace(/\s+/g, ""));
    if (local) out.set(local, this.parties.get(local)!);
    return [...out.values()].filter(Boolean);
  }
}

// ---------------------------------------------------------------- candidates --

function asDate(v: Date | string | null): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function gatherCandidates(db: pg.Pool | pg.PoolClient, deps: ResolveDeps, row: InteractionRow, notes: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (row.source === "zoom" && row.source_ref && deps.zoomParticipants) {
    const list = await deps.zoomParticipants(row.source_ref);
    if (list) for (const p of list) out.push({ name: p.name, email: p.email, via: "zoom_api" });
  }
  const start = asDate(row.occurred_at);
  if (start && deps.calendarAttendees && (row.source === "zoom" || row.source === "meet")) {
    const end = new Date(start.getTime() + Math.max(15 * 60, Number(row.duration_sec ?? 3600)) * 1000);
    const guests = await deps.calendarAttendees(start, end, row.title);
    if (guests) for (const g of guests) out.push({ name: g.name, email: g.email, via: "calendar" });
  }
  for (const p of row.participants_raw ?? []) {
    const kind = String(p.kind ?? "");
    const ident = typeof p.identifier === "string" ? p.identifier : null;
    out.push({
      name: typeof p.name === "string" ? p.name : null,
      email: kind === "email" ? ident : null,
      phone: kind === "phone" ? ident : null,
      partyId: p.party_id != null ? Number(p.party_id) : null,
      via: "contact",
    });
  }
  for (const n of parseTitleNamesDetailed(row.title, deps.ownerNames)) out.push({ name: n.name, email: null, via: "title", strong: n.strong });
  const { rows } = await db.query(`select distinct speaker from segments where interaction_id = $1 and speaker is not null limit 40`, [row.id]);
  for (const r of rows) {
    const s = String(r.speaker).trim();
    if (looksLikeName(s) && !/^speaker\s*\d+$/i.test(s)) out.push({ name: s, email: null, via: "transcript" });
  }
  if (!out.length) notes.push("no candidates");
  return out;
}

// ---------------------------------------------------------------- resolve --

async function linkParticipant(db: pg.Pool | pg.PoolClient, interactionId: number, partyId: number, confidence: number, via: CandidateSource): Promise<boolean> {
  const r = await db.query(
    `insert into interaction_participants (interaction_id, party_id, speaker_label, confidence, resolved_by)
     values ($1, $2, null, $3, $4) on conflict (interaction_id, party_id) do nothing`,
    [interactionId, partyId, confidence, via],
  );
  return (r.rowCount ?? 0) > 0;
}

async function createParty(db: pg.Pool | pg.PoolClient, c: Candidate, interactionId: number): Promise<{ id: number; name: string }> {
  const email = normalizeEmail(c.email ?? "");
  const name = c.name && looksLikeName(c.name) ? displayName(c.name) : email!;
  const { rows } = await db.query<{ id: number }>(
    `insert into parties (kind, name, emails, external_refs) values ('person', $1, $2::text[], $3::jsonb) returning id`,
    [name, email ? [email] : [], JSON.stringify({ created_by: RESOLVER_TAG, from: c.via, interaction_id: interactionId })],
  );
  return { id: Number(rows[0].id), name };
}

/** Queues "is this the same person?" for Review, once per interaction and party. */
async function suggestMatch(db: pg.Pool | pg.PoolClient, interactionId: number, party: { id: number; name: string }, candidate: string, via: CandidateSource): Promise<boolean> {
  const dup = await db.query(
    `select 1 from review_queue where interaction_id = $1 and item_type = 'link_party_interaction' and proposal->>'party_id' = $2 limit 1`,
    [interactionId, String(party.id)],
  );
  if (dup.rowCount) return false;
  await db.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('link_party_interaction', $1::jsonb, $2, $3, 'open')`, [
    JSON.stringify({ party_id: party.id, interaction_id: interactionId, confidence: 0.5, source: RESOLVER_TAG, suggested_from: candidate, via, proposed_at: new Date().toISOString() }),
    `Suggested match: "${candidate}" (${via === "title" ? "in the title" : via === "transcript" ? "a transcript speaker" : via}) looks like ${party.name}. Not linked or merged automatically; approve to link this recording to them.`,
    interactionId,
  ]);
  return true;
}

/**
 * Resolves one interaction's participants and files it when that settles the workspace. Runs on
 * the caller's client (the backfill's dry run wraps it in a transaction it rolls back).
 */
export async function resolveInteraction(db: pg.Pool | pg.PoolClient, deps: ResolveDeps, index: PartyIndex, row: InteractionRow): Promise<ResolveResult> {
  const result: ResolveResult = { interactionId: row.id, title: row.title, linked: [], suggested: [], unresolved: [], workspaceBefore: row.workspace_id, workspaceAfter: row.workspace_id, filedBy: null };
  const notes: string[] = [];
  const candidates = await gatherCandidates(db, deps, row, notes);
  const ownerEmails = new Set([...deps.owner.emails, ...(row.host_email ? [normalizeEmail(row.host_email)!] : [])].filter(Boolean));
  const linkedIds = new Set<number>();
  const handledNames = new Set<string>();
  const existing = await db.query(`select party_id from interaction_participants where interaction_id = $1`, [row.id]);
  for (const r of existing.rows) linkedIds.add(Number(r.party_id));

  const link = async (partyId: number, name: string, c: Candidate, how: Linked["how"], confidence: number) => {
    if (c.name) handledNames.add(normalizeName(c.name));
    handledNames.add(normalizeName(name));
    if (linkedIds.has(partyId)) return;
    linkedIds.add(partyId);
    await linkParticipant(db, row.id, partyId, confidence, c.via);
    result.linked.push({ partyId, name, via: c.via, how, isLead: index.parties.get(partyId)?.isLead ?? false });
  };

  for (const c of candidates) {
    const email = normalizeEmail(c.email ?? "");
    const phone = normalizeIdentifier(c.phone ?? null);
    if ((email && ownerEmails.has(email)) || (phone && isOwner(deps.owner, phone)) || (c.name && isOwnerName(c.name, deps.ownerNames) && !email)) continue;
    if (c.partyId) {
      const known = index.parties.get(c.partyId);
      if (known) await link(c.partyId, known.name, c, "contact", 0.95);
      continue;
    }
    if (email) {
      const hit = index.byEmail.get(email);
      if (hit) {
        const p = index.parties.get(hit)!;
        // A real name replaces a placeholder (a lead who signed up with an email only), nothing else is overwritten.
        if (p.placeholder && c.name && looksLikeName(c.name)) {
          const nice = displayName(c.name);
          await db.query(`update parties set name = $2, updated_at = now() where id = $1 and name like '%@%'`, [hit, nice]);
          index.add({ id: hit, name: nice, emails: [email], isLead: p.isLead });
        }
        await link(hit, index.parties.get(hit)!.name, c, p.isLead ? "lead_email" : "email", 1);
        continue;
      }
      // Unknown email: same person as a name already matched? Otherwise a new party.
      const sameName = c.name ? index.exact(c.name) : [];
      if (sameName.length === 1) {
        await db.query(`update parties set emails = array_append(coalesce(emails, '{}'), $2), updated_at = now() where id = $1 and not ($2 = any(coalesce(emails, '{}')))`, [sameName[0].id, email]);
        index.add({ id: sameName[0].id, name: sameName[0].name, emails: [email], isLead: sameName[0].isLead });
        await link(sameName[0].id, sameName[0].name, c, sameName[0].isLead ? "lead_name" : "name", 0.9);
        continue;
      }
      const created = await createParty(db, c, row.id);
      index.add({ id: created.id, name: created.name, emails: [email] });
      await link(created.id, created.name, c, "created", 0.9);
      continue;
    }
    if (phone && phone.kind === "phone") {
      const m = await matchParties(db, [phone]);
      const hit = m.get(phone.value);
      if (hit) {
        await link(hit.id, hit.name, c, "phone", 1);
        continue;
      }
    }
    if (!c.name || !looksLikeName(c.name)) continue;
    const key = normalizeName(c.name);
    if (handledNames.has(key)) continue;
    handledNames.add(key);
    // A first name alone from free text ("John" in "Brad Jeremy Ben and John") is never matched to anyone.
    if (c.via === "title" && !c.strong && key.split(" ").length < 2) {
      result.unresolved.push(c.name);
      continue;
    }
    const exact = index.exact(c.name);
    const pick = exact.length === 1 ? exact[0] : exact.filter((p) => p.isLead).length === 1 ? exact.find((p) => p.isLead)! : null;
    if (pick) {
      await link(pick.id, pick.name, c, pick.isLead ? "lead_name" : "name", c.via === "title" ? 0.85 : 0.8);
      continue;
    }
    if (exact.length > 1) {
      result.unresolved.push(`${c.name} (${exact.length} people share the name)`);
      continue;
    }
    const near = index.fuzzy(c.name).filter((p) => !linkedIds.has(p.id));
    if (near.length) {
      for (const p of near.slice(0, 3)) {
        if (await suggestMatch(db, row.id, { id: p.id, name: p.name }, displayName(c.name), c.via)) result.suggested.push({ partyId: p.id, name: p.name, candidate: displayName(c.name), via: c.via });
      }
      continue;
    }
    // Nothing matches: a full name becomes a new person, but only from a source that names people on
    // purpose (a contact card, Zoom, a calendar guest, a title in a "<Name>: …" shape). A first name
    // alone ("Devon") or a name picked out of free text stays unresolved.
    if (key.split(" ").length >= 2 && ((c.via === "title" && c.strong) || c.via === "contact" || c.via === "zoom_api" || c.via === "calendar")) {
      const created = await createParty(db, c, row.id);
      index.add({ id: created.id, name: created.name });
      await link(created.id, created.name, c, "created", 0.8);
    } else {
      result.unresolved.push(c.name);
    }
  }

  // ---- filing: still unfiled (or in inbox)? title rules first, then the people on it.
  if (row.workspace_id == null || row.workspace_id === INBOX) {
    const filed = await fileFromSignals(db, deps, row, [...linkedIds]);
    if (filed) {
      result.workspaceAfter = filed.workspaceId;
      result.filedBy = filed.filedBy;
    }
  }
  await db.query(`update interactions set participants_resolved_at = now() where id = $1`, [row.id]);
  return result;
}

/** Files an unfiled or inbox interaction by title rule, else by its participants' workspaces. */
async function fileFromSignals(db: pg.Pool | pg.PoolClient, deps: ResolveDeps, row: InteractionRow, partyIds: number[]): Promise<{ workspaceId: string; filedBy: string } | null> {
  const known = new Set((await db.query(`select id from workspaces`)).rows.map((r) => r.id as string));
  const refused = await rejectedWorkspaces(db, row.id);
  const tryFile = async (ws: string, filedBy: string) => {
    if (!known.has(ws) || ws === INBOX || NEVER_AUTO_ASSIGNED.includes(ws) || refused.has(ws)) return null;
    const moved = await db.query(`update interactions set workspace_id = $2, filed_by = $3, updated_at = now() where id = $1 and (workspace_id is null or workspace_id = '${INBOX}')`, [row.id, ws, filedBy]);
    if (!moved.rowCount) return null;
    await db.query(`update media set workspace_id = $2 where interaction_id = $1 and (workspace_id is null or workspace_id = '${INBOX}')`, [row.id, ws]);
    await db.query(`update review_queue set status = 'approved', decided_at = now() where interaction_id = $1 and item_type = any($2::text[]) and status = 'open' and proposal->>'workspace_id' = $3`, [
      row.id,
      WORKSPACE_DECISION_TYPES,
      ws,
    ]);
    return { workspaceId: ws, filedBy };
  };
  const rule = matchFilingRule(row.title, row.source, deps.filingRules);
  if (rule) {
    const r = await tryFile(rule.rule.workspaceId, `rule:${rule.rule.index}`);
    if (r) return r;
  }
  if (!partyIds.length) return null;
  const emails: string[] = [];
  const byEmail = new Map<string, PartyRef>();
  const route = await routeThread(db, partyIds, emails, byEmail, deps.rules, known);
  if (route.review || route.workspaceId === INBOX) return null;
  return tryFile(route.workspaceId, "participants");
}
