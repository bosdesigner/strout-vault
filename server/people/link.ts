// Worker step `link` (Phase 1 v2): puts people on interactions that came in without them.
//
// Zoom meetings, in order of trust:
//   1. Zoom's own participant list (past_meetings/{uuid}/participants, needs meeting:read:admin or
//      report:read:admin on the Server-to-Server app; when the app lacks the scope this is recorded
//      once in worker_state and skipped for a week), then the meeting's registrants.
//   2. The Google Calendar event at the same time (the Meet account's calendar.events.readonly
//      grant): attendee emails. Calendly bookings put the invitee there.
//   3. The name in the title ("Ryan Meagher: AnotherStory Assessment", "Ben and Stephen Jones").
//   4. Transcript speaker labels that are names (Zoom's own VTT labels speakers by display name).
// Each candidate matches a party by email first, then by normalised full name or first + last name
// to exactly one party. Anything only close ("Bejamin Schiavi" for Benjamin Schiavi) becomes a
// `participant_match` review item, never a link. Ben himself is never "the other participant".
//
// iPhone calls: the number the collector sent, matched to a party's phones; for a "Call Recording"
// with no number, the name the classifier read from the call (classify_evidence.other_party), exact
// matches only. A matched call titled "Call Recording" is retitled "Call with <Name>".
// Texts, email and everything else: identifiers in participants_raw that now match a party (a lead
// imported after the thread arrived) are linked the way the ingest would have linked them.
//
// Linking a person who is a lead (lead_records.party_id) is what makes the call their latest
// conversation on /leads and in list_leads: both read interaction_participants.
import type pg from "pg";
import type { WorkerContext } from "../worker/context.ts";
import { outOfTime } from "../worker/context.ts";
import { getState, makeZoomClient, setState, zoomConfigured } from "../worker/sync.ts";
import { findOwnerParty, matchParties, type PartyRef } from "../messages/ingest.ts";
import { normalizeIdentifier, ownerIdentity, isOwner, normalizeEmail, type OwnerIdentity } from "../messages/identity.ts";
import { listMeetAccounts, meetClientFor } from "../meet/sync.ts";
import { CALENDAR_EVENTS_READONLY_SCOPE, type MeetClient } from "../meet/api.ts";
import { firstLastKey, isOwnerName, normalizeName, parseTitle, looksLikeName, displayName } from "../workspaces/titles.ts";

export const LINK_LOCK = "strout-vault-link";
const ZOOM_PARTICIPANTS_STATE = "zoom_participants_api";
/** Trigram similarity for a suggested (never automatic) name match. */
export const SUGGEST_SIMILARITY = 0.5;
const CALL_TITLE = /^\s*call(\s+recording)?\s*$/i;

export interface LinkSummary {
  candidates: number;
  linked: number;
  /** interaction_participants rows written, by how the person was found. */
  bySource: Record<string, number>;
  suggested: number;
  retitled: number;
  zoomApi: "used" | "unavailable" | "off";
  calendar: "used" | "unavailable" | "off";
  failed: number;
  stoppedEarly?: string;
  errors: string[];
}

export interface PersonCandidate {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** zoom_api | registrant | calendar | title | speaker | phone | identifier | classifier */
  source: string;
  /** The transcript label this person speaks under, when known. */
  speakerLabel?: string | null;
}

export interface PartyRow {
  id: number;
  name: string;
}

export type NameMatch = { kind: "exact"; party: PartyRow } | { kind: "suggest"; party: PartyRow; similarity: number } | { kind: "ambiguous"; parties: PartyRow[] } | { kind: "none" };

/**
 * Matches a name against parties: exact normalised name, else first + last name, to exactly one party.
 * `fuzzy` are trigram neighbours (from the database), offered only as a suggestion. Pure.
 */
export function matchName(name: string, exactPool: PartyRow[], fuzzy: Array<PartyRow & { similarity: number }> = []): NameMatch {
  const n = normalizeName(name);
  if (!n) return { kind: "none" };
  const exact = exactPool.filter((p) => normalizeName(p.name) === n);
  if (exact.length === 1) return { kind: "exact", party: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", parties: exact };
  const fl = firstLastKey(name);
  if (fl) {
    const byFl = exactPool.filter((p) => firstLastKey(p.name) === fl);
    if (byFl.length === 1) return { kind: "exact", party: byFl[0] };
    if (byFl.length > 1) return { kind: "ambiguous", parties: byFl };
  }
  // One-word names ("Nea") are never matched on their own: too many people share a first name.
  if (n.split(" ").length < 2) return { kind: "none" };
  const best = fuzzy.filter((f) => f.similarity >= SUGGEST_SIMILARITY).sort((a, b) => b.similarity - a.similarity)[0];
  return best ? { kind: "suggest", party: { id: best.id, name: best.name }, similarity: best.similarity } : { kind: "none" };
}

interface Row {
  id: number;
  kind: string;
  source: string | null;
  sourceRef: string | null;
  title: string | null;
  occurredAt: Date | null;
  durationSec: number | null;
  payload: Record<string, unknown>;
  participantsRaw: Array<{ kind?: string; identifier?: string | null; name?: string | null }>;
  existing: Set<number>;
  speakers: string[];
  otherParty: string | null;
}

async function loadRows(pool: pg.Pool, limit: number, ids?: number[]): Promise<Row[]> {
  const params: unknown[] = [limit];
  let where = `i.linked_at is null`;
  if (ids?.length) {
    params.push(ids);
    where = `i.id = any($2::bigint[])`;
  }
  const { rows } = await pool.query(
    `select i.id, i.kind, i.source, i.source_ref, i.title, i.occurred_at, i.duration_sec, i.source_payload, i.participants_raw,
            i.classify_evidence->>'other_party' as other_party,
            coalesce((select array_agg(ip.party_id) from interaction_participants ip where ip.interaction_id = i.id), '{}') as existing,
            coalesce((select array_agg(distinct s.speaker) from segments s where s.interaction_id = i.id and s.speaker is not null and s.speaker_party_id is null), '{}') as speakers
       from interactions i
      where ${where}
      order by i.occurred_at desc nulls last, i.id desc
      limit $1`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    source: r.source,
    sourceRef: r.source_ref,
    title: r.title,
    occurredAt: r.occurred_at ? new Date(r.occurred_at) : null,
    durationSec: r.duration_sec != null ? Number(r.duration_sec) : null,
    payload: (r.source_payload ?? {}) as Record<string, unknown>,
    participantsRaw: Array.isArray(r.participants_raw) ? r.participants_raw : [],
    existing: new Set((r.existing as Array<string | number>).map(Number)),
    speakers: (r.speakers as string[]).filter(Boolean),
    otherParty: r.other_party ?? null,
  }));
}

/** Zoom participants and registrants for one meeting; null when the API is not available to this app. */
async function zoomPeople(ctx: WorkerContext, row: Row, state: { available: boolean }): Promise<PersonCandidate[] | null> {
  if (!state.available || row.source !== "zoom" || !row.sourceRef) return null;
  const client = makeZoomClient(ctx);
  const uuid = encodeURIComponent(encodeURIComponent(row.sourceRef)); // Zoom wants a UUID with / or // double-encoded
  const out: PersonCandidate[] = [];
  try {
    for await (const p of client.paged<{ name?: string; user_email?: string }>(`/past_meetings/${uuid}/participants`, {}, "participants")) {
      out.push({ name: p.name ?? null, email: p.user_email || null, source: "zoom_api" });
    }
  } catch (err) {
    const msg = (err as Error).message;
    // Scope missing (4711 / 4700 / 401 / 403) or the meeting is gone (404/3001): remember the first, skip the second.
    if (/\b(400|401|403)\b|scope|4711|4700|does not contain scopes/i.test(msg) && !/\b404\b|3001/.test(msg)) {
      state.available = false;
      await setState(ctx, ZOOM_PARTICIPANTS_STATE, { available: false, checked_at: ctx.now().toISOString(), error: msg.slice(0, 300) });
      return null;
    }
  }
  const meetingId = row.payload.id;
  if (meetingId) {
    try {
      for await (const r of client.paged<{ first_name?: string; last_name?: string; email?: string }>(`/meetings/${meetingId}/registrants`, { status: "approved" }, "registrants")) {
        out.push({ name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null, email: r.email || null, source: "registrant" });
      }
    } catch {
      /* most meetings have no registration; nothing to record */
    }
  }
  return out;
}

/** Attendees of the calendar event that starts within 20 minutes of the meeting and mentions Zoom (or is the only one). */
export function pickCalendarEvent<T extends { start?: { dateTime?: string }; location?: string; description?: string; attendees?: unknown[] }>(events: T[], startedAt: Date, zoomId: string | null): T | null {
  const near = events.filter((e) => {
    const s = e.start?.dateTime ? new Date(e.start.dateTime).getTime() : NaN;
    return Number.isFinite(s) && Math.abs(s - startedAt.getTime()) <= 20 * 60_000 && (e.attendees?.length ?? 0) > 0;
  });
  const zoomy = near.filter((e) => /zoom\.us|zoom meeting/i.test(`${e.location ?? ""} ${e.description ?? ""}`) || (zoomId && `${e.location ?? ""} ${e.description ?? ""}`.replace(/\s/g, "").includes(zoomId)));
  if (zoomy.length === 1) return zoomy[0];
  return near.length === 1 ? near[0] : null;
}

async function calendarPeople(cal: MeetClient | null, row: Row, owner: OwnerIdentity): Promise<PersonCandidate[] | null> {
  if (!cal || !row.occurredAt) return null;
  const from = new Date(row.occurredAt.getTime() - 30 * 60_000);
  const to = new Date(row.occurredAt.getTime() + 30 * 60_000);
  const events = (await cal.events(from, to)) as Array<{ start?: { dateTime?: string }; location?: string; description?: string; attendees?: Array<{ email?: string; displayName?: string; resource?: boolean }> }>;
  const ev = pickCalendarEvent(events, row.occurredAt, row.payload.id ? String(row.payload.id) : null);
  if (!ev) return [];
  return (ev.attendees ?? [])
    .filter((a) => a.email && !a.resource && !isOwner(owner, { kind: "email", value: normalizeEmail(a.email) ?? a.email }))
    .map((a) => ({ name: a.displayName ?? null, email: a.email ?? null, source: "calendar" }));
}

/** Candidates from the row itself: title names, speaker labels, raw identifiers, the classifier's name for a call. */
export function localCandidates(row: Pick<Row, "kind" | "source" | "title" | "speakers" | "participantsRaw" | "otherParty">): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  for (const p of row.participantsRaw) {
    if (p.kind === "phone" && p.identifier) out.push({ phone: p.identifier, name: p.name ?? null, source: "phone" });
    else if (p.kind === "email" && p.identifier) out.push({ email: p.identifier, name: p.name ?? null, source: "identifier" });
    else if (p.kind === "name" && p.name) out.push({ name: p.name, source: "identifier" });
  }
  if (["meeting", "other", "call", "recording"].includes(row.kind)) {
    for (const n of parseTitle(row.title).names) out.push({ name: n, source: "title" });
    for (const label of row.speakers) {
      const name = label.trim();
      if (!isOwnerName(name) && looksLikeName(name) && name.split(/\s+/).length >= 2) out.push({ name: displayName(name), source: "speaker", speakerLabel: label });
    }
  }
  if (row.otherParty && ["call", "recording"].includes(row.kind) && !row.participantsRaw.length) out.push({ name: row.otherParty, source: "classifier" });
  return out;
}

async function exactNamePool(pool: pg.Pool, names: string[]): Promise<PartyRow[]> {
  const keys = [...new Set(names.flatMap((n) => [normalizeName(n), firstLastKey(n)].filter((x): x is string => !!x)))];
  if (!keys.length) return [];
  const { rows } = await pool.query(
    `select id, name from parties
      where kind = 'person' and merged_into is null
        and (trim(regexp_replace(regexp_replace(lower(name), '[''’.]', '', 'g'), '[^a-z0-9]+', ' ', 'g')) = any($1::text[])
             or split_part(trim(regexp_replace(regexp_replace(lower(name), '[''’.]', '', 'g'), '[^a-z0-9]+', ' ', 'g')), ' ', 1) = any($2::text[]))`,
    [keys, [...new Set(keys.map((k) => k.split(" ")[0]))]],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

async function fuzzyPool(pool: pg.Pool, name: string): Promise<Array<PartyRow & { similarity: number }>> {
  const { rows } = await pool.query(
    `select id, name, similarity(name, $1) as sim from parties where kind = 'person' and merged_into is null and name % $1 order by sim desc limit 3`,
    [name],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, similarity: Number(r.sim) }));
}

async function link(pool: pg.Pool, interactionId: number, partyId: number, label: string | null, confidence: number, speakerLabel: string | null) {
  await pool.query(
    `insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values ($1, $2, $3, $4)
     on conflict (interaction_id, party_id) do update set confidence = greatest(coalesce(interaction_participants.confidence, 0), excluded.confidence),
            speaker_label = coalesce(interaction_participants.speaker_label, excluded.speaker_label)`,
    [interactionId, partyId, label, confidence],
  );
  if (speakerLabel) await pool.query(`update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and speaker_party_id is null`, [interactionId, partyId, speakerLabel]);
}

async function suggest(pool: pg.Pool, row: Row, c: PersonCandidate, party: PartyRow, similarity: number) {
  const dup = await pool.query(`select 1 from review_queue where interaction_id = $1 and item_type = 'participant_match' and (proposal->>'party_id')::bigint = $2`, [row.id, party.id]);
  if (dup.rowCount) return false;
  await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('participant_match', $1::jsonb, $2, $3, 'open')`, [
    JSON.stringify({ interaction_id: row.id, party_id: party.id, speaker_label: c.speakerLabel ?? null, confidence: Number(similarity.toFixed(2)), evidence: { name: c.name, source: c.source }, source: "link" }),
    `Is “${c.name}” (${c.source}) on "${row.title ?? `#${row.id}`}" ${party.name}? Close name match only (${Math.round(similarity * 100)}%).`,
    row.id,
  ]);
  return true;
}

const SOURCE_CONFIDENCE: Record<string, number> = { zoom_api: 0.95, registrant: 0.95, calendar: 0.95, phone: 0.95, identifier: 0.95, title: 0.85, speaker: 0.85, classifier: 0.7 };

export async function processLink(ctx: WorkerContext, opts: { ids?: number[]; limit?: number } = {}): Promise<LinkSummary> {
  const summary: LinkSummary = { candidates: 0, linked: 0, bySource: {}, suggested: 0, retitled: 0, zoomApi: "off", calendar: "off", failed: 0, errors: [] };
  const lock = await ctx.pool.connect();
  let locked = false;
  try {
    locked = !!(await lock.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LINK_LOCK])).rows[0]?.ok;
    if (!locked) {
      summary.stoppedEarly = "another link step is running";
      return summary;
    }
    const accounts = (await ctx.pool.query(`select account_email from message_accounts`).catch(() => ({ rows: [] as Array<{ account_email: string }> }))).rows.map((r) => r.account_email);
    const owner = ownerIdentity(ctx.config, accounts);
    const ownerParty = await findOwnerParty(ctx.pool, owner);
    const rows = await loadRows(ctx.pool, opts.limit ?? ctx.config.LINK_MAX_PER_RUN, opts.ids);
    summary.candidates = rows.length;
    if (!rows.length) return summary;

    // Zoom participants API: available unless a recent check said the app lacks the scope.
    const zstate = { available: zoomConfigured(ctx) };
    if (zstate.available) {
      const prior = await getState<{ available: boolean; checked_at: string }>(ctx, ZOOM_PARTICIPANTS_STATE);
      if (prior && !prior.available && ctx.now().getTime() - new Date(prior.checked_at).getTime() < 7 * 86_400_000) zstate.available = false;
    }
    summary.zoomApi = zoomConfigured(ctx) ? (zstate.available ? "used" : "unavailable") : "off";
    // Calendar: the first Meet account that granted calendar.events.readonly.
    let cal: MeetClient | null = null;
    if (ctx.config.GOOGLE_CLIENT_ID && ctx.config.GOOGLE_CLIENT_SECRET && ctx.config.MESSAGES_ENCRYPTION_KEY && rows.some((r) => r.source === "zoom")) {
      const acct = (await listMeetAccounts(ctx.pool)).find((a) => a.scope.split(" ").includes(CALENDAR_EVENTS_READONLY_SCOPE));
      if (acct) {
        cal = meetClientFor(ctx, acct);
        summary.calendar = "used";
      } else summary.calendar = "unavailable";
    }

    for (const row of rows) {
      if (outOfTime(ctx)) {
        summary.stoppedEarly = "time budget";
        break;
      }
      try {
        const people: PersonCandidate[] = [];
        if (row.source === "zoom") {
          const z = await zoomPeople(ctx, row, zstate);
          if (z) people.push(...z);
          if (!zstate.available && zoomConfigured(ctx)) summary.zoomApi = "unavailable";
          if (!people.some((p) => p.email)) {
            try {
              const c = await calendarPeople(cal, row, owner);
              if (c) people.push(...c);
            } catch (err) {
              summary.errors.push(`calendar #${row.id}: ${(err as Error).message.slice(0, 120)}`);
              cal = null;
              summary.calendar = "unavailable";
            }
          }
        }
        people.push(...localCandidates(row));

        const linkedNow = new Map<number, string>();
        const add = async (party: PartyRef | PartyRow, c: PersonCandidate) => {
          if (party.id === ownerParty?.id || isOwnerName(party.name)) return;
          if (row.existing.has(party.id) || linkedNow.has(party.id)) {
            // Already on it (from the title, say): still give their transcript lines the person.
            if (c.speakerLabel) await ctx.pool.query(`update segments set speaker_party_id = $2 where interaction_id = $1 and speaker = $3 and speaker_party_id is null`, [row.id, party.id, c.speakerLabel]);
            return;
          }
          await link(ctx.pool, row.id, party.id, c.speakerLabel ?? c.name ?? null, SOURCE_CONFIDENCE[c.source] ?? 0.8, c.speakerLabel ?? null);
          linkedNow.set(party.id, party.name);
          summary.bySource[c.source] = (summary.bySource[c.source] ?? 0) + 1;
        };

        // 1. Emails and phones, exactly.
        const ids = people
          .flatMap((c) => [c.email ? normalizeIdentifier(c.email) : null, c.phone ? normalizeIdentifier(c.phone) : null])
          .filter((x): x is NonNullable<typeof x> => !!x && !isOwner(owner, x));
        const byId = ids.length ? await matchParties(ctx.pool, ids) : new Map<string, PartyRef>();
        const named: PersonCandidate[] = [];
        for (const c of people) {
          const key = c.email ? normalizeIdentifier(c.email)?.value : c.phone ? normalizeIdentifier(c.phone)?.value : null;
          const hit = key ? byId.get(key) : undefined;
          if (hit) await add(hit, c);
          else if (c.name && !isOwnerName(c.name) && !(c.email && isOwner(owner, normalizeIdentifier(c.email)))) named.push(c);
        }
        // 2. Names: exact or first + last to one party; close names are suggestions.
        const pool = await exactNamePool(ctx.pool, named.map((c) => c.name!));
        const seenNames = new Set<string>();
        for (const c of named) {
          const key = `${normalizeName(c.name)}|${c.speakerLabel ?? ""}`;
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          const m = matchName(c.name!, pool, normalizeName(c.name).split(" ").length >= 2 ? await fuzzyPool(ctx.pool, c.name!) : []);
          if (m.kind === "exact") await add(m.party, c);
          else if (m.kind === "suggest" && !row.existing.has(m.party.id) && !linkedNow.has(m.party.id) && m.party.id !== ownerParty?.id) {
            if (await suggest(ctx.pool, row, c, m.party, m.similarity)) summary.suggested++;
          }
        }
        if (linkedNow.size) summary.linked++;

        // 3. "Call Recording" -> "Call with <Name>".
        if (row.kind === "call" && CALL_TITLE.test(row.title ?? "") && linkedNow.size === 1) {
          const [name] = [...linkedNow.values()];
          await ctx.pool.query(`update interactions set title = $2, updated_at = now() where id = $1 and title = $3`, [row.id, `Call with ${name}`, row.title]);
          summary.retitled++;
        }
        await ctx.pool.query(`update interactions set linked_at = now(), link_error = null where id = $1`, [row.id]);
      } catch (err) {
        summary.failed++;
        const msg = (err as Error).message.slice(0, 300);
        summary.errors.push(`#${row.id}: ${msg}`);
        await ctx.pool.query(`update interactions set link_error = $2 where id = $1`, [row.id, msg]).catch(() => {});
      }
    }
    ctx.log(
      `link: ${summary.linked}/${summary.candidates} interaction(s) got people (${Object.entries(summary.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}), ${summary.suggested} suggestion(s), ${summary.retitled} call(s) retitled; zoom api ${summary.zoomApi}, calendar ${summary.calendar}`,
    );
    return summary;
  } finally {
    if (locked) await lock.query(`select pg_advisory_unlock(hashtext($1))`, [LINK_LOCK]).catch(() => {});
    lock.release();
  }
}

/** Parties sharing an email (case and whitespace ignored), the lower id first: the obvious duplicates. */
export async function duplicateParties(pool: pg.Pool): Promise<Array<{ keep: number; dup: number; email: string }>> {
  const { rows } = await pool.query(
    `select lower(trim(e)) as email, array_agg(distinct p.id order by p.id) as ids
       from parties p cross join lateral unnest(p.emails) e
      where p.merged_into is null and trim(e) <> ''
      group by 1 having count(distinct p.id) > 1`,
  );
  const out: Array<{ keep: number; dup: number; email: string }> = [];
  for (const r of rows) {
    const ids = (r.ids as Array<string | number>).map(Number);
    for (const dup of ids.slice(1)) out.push({ keep: ids[0], dup, email: r.email });
  }
  return out;
}

/** Moves everything that points at `dup` onto `keep`, merges emails and phones, and marks `dup` merged. */
export async function mergeParties(pool: pg.Pool, keep: number, dup: number): Promise<void> {
  if (keep === dup) return;
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(`update parties k set emails = (select array(select distinct x from unnest(k.emails || d.emails) x)), phones = (select array(select distinct x from unnest(k.phones || d.phones) x)), updated_at = now() from parties d where k.id = $1 and d.id = $2`, [keep, dup]);
    await db.query(`insert into roles (workspace_id, party_id, role, status, market, detail, started_at, ended_at, source_interaction_id) select workspace_id, $1, role, status, market, detail, started_at, ended_at, source_interaction_id from roles where party_id = $2 on conflict (workspace_id, party_id, role) do nothing`, [keep, dup]);
    await db.query(`delete from roles where party_id = $1`, [dup]);
    await db.query(`insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) select interaction_id, $1, speaker_label, confidence from interaction_participants where party_id = $2 on conflict (interaction_id, party_id) do nothing`, [keep, dup]);
    await db.query(`delete from interaction_participants where party_id = $1`, [dup]);
    await db.query(`insert into affiliations (person_id, org_id, title, is_current) select $1, org_id, title, is_current from affiliations where person_id = $2 on conflict (person_id, org_id) do nothing`, [keep, dup]);
    await db.query(`delete from affiliations where person_id = $1`, [dup]);
    await db.query(`insert into project_parties (project_id, party_id, role) select project_id, $1, role from project_parties where party_id = $2 on conflict do nothing`, [keep, dup]);
    await db.query(`delete from project_parties where party_id = $1`, [dup]);
    for (const [table, col] of [["facts", "owner_party_id"], ["facts", "about_party_id"], ["segments", "speaker_party_id"], ["lead_records", "party_id"], ["media", "uploaded_by"]] as const) {
      await db.query(`update ${table} set ${col} = $1 where ${col} = $2`, [keep, dup]);
    }
    await db.query(`update relationships set from_party_id = $1 where from_party_id = $2 and not exists (select 1 from relationships r2 where r2.from_party_id = $1 and r2.to_party_id = relationships.to_party_id and r2.kind = relationships.kind and r2.workspace_id is not distinct from relationships.workspace_id)`, [keep, dup]);
    await db.query(`update relationships set to_party_id = $1 where to_party_id = $2 and not exists (select 1 from relationships r2 where r2.to_party_id = $1 and r2.from_party_id = relationships.from_party_id and r2.kind = relationships.kind and r2.workspace_id is not distinct from relationships.workspace_id)`, [keep, dup]);
    await db.query(`update parties set merged_into = $1, updated_at = now() where id = $2`, [keep, dup]);
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
