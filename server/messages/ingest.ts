// The one path every text and email takes into the vault, whichever collector read it (the
// iMessage collector on the Mac via POST /api/ingest/messages, or the Gmail worker step):
//
//   filter    drop what must never be stored: Gmail Promotions/Social/Updates/Forums, mail with
//             a List-Unsubscribe header, blocklisted senders, SMS short codes, one-time codes
//   redact    card numbers, SSNs and bank routing/account numbers become [REDACTED]
//   merge     with what the thread already holds (a day of texts arrives in several batches; a
//             Gmail thread grows), by message id
//   match     senders to parties by E.164 phone / lowercase email; unknown identifiers are queued
//             for review (item_type new_party), never created
//   route     new threads to the one workspace their participants map to, else `inbox`, plus a
//             workspace_assignment review row when there is a workspace to suggest (several
//             candidates, or phalanx, which is never assigned automatically). A thread nobody known
//             is on just waits in inbox: server/workspaces/refile.ts files it once its people are known
//   write     one interaction per thread (upsert on source + source_ref), one segments row per
//             message, transcript as "[HH:MM] Name: text" lines, pipeline_status 'ready' and a
//             fresh pipeline_updated_at so the existing embedding step picks it up
//
// content_sha256 covers the message ids and bodies: a re-import that brings nothing new writes
// nothing. Message text is never logged; only counts are.
import crypto from "node:crypto";
import type pg from "pg";
import { isOneTimeCode, redactOneTimeCodes, redactSensitive } from "./redact.ts";
import { emailDomain, isOwner, normalizeIdentifier, phoneDigitKeys, type Identifier, type OwnerIdentity } from "./identity.ts";
import type { MessageRules } from "./rules.ts";

export type MessageSource = "imessage" | "gmail";
export type ThreadKind = "text_thread" | "email_thread";
export const MESSAGE_KINDS: ThreadKind[] = ["text_thread", "email_thread"];
export const MESSAGE_SOURCES: MessageSource[] = ["imessage", "gmail"];
export const INBOX = "inbox";
export const NEVER_AUTO_ASSIGNED = ["phalanx"];
export const LOCAL_TIMEZONE = "America/Chicago";

export interface MessageAttachment {
  filename: string | null;
  mime: string | null;
  size: number | null;
}

export interface MessageInput {
  /** Stable id from the source (iMessage guid, Gmail message id). */
  id: string;
  sentAt: Date;
  fromMe: boolean;
  /** Raw sender handle: phone, email, short code. Null for Ben's own iMessages. */
  from: string | null;
  fromName?: string | null;
  /** Raw recipient handles (To on email); used to find who Ben wrote to. */
  to?: string[];
  text: string;
  /** Metadata only; attachment bytes are never sent here. */
  attachments?: MessageAttachment[];
  /** Gmail labelIds (CATEGORY_PROMOTIONS, DRAFT, ...). */
  labels?: string[];
  /** True when the email carries a List-Unsubscribe header. */
  listUnsubscribe?: boolean;
}

export interface ThreadInput {
  source: MessageSource;
  kind: ThreadKind;
  sourceRef: string;
  title: string | null;
  /** Everyone else in the conversation (iMessage chat members), whether or not they wrote. */
  participants?: Array<{ identifier: string; name?: string | null }>;
  messages: MessageInput[];
  /** Thread-level facts kept in source_payload (account, thread id, chat guid, local date). */
  meta?: Record<string, unknown>;
}

export type SkipReason =
  | "category_promotions"
  | "category_social"
  | "category_updates"
  | "category_forums"
  | "list_unsubscribe"
  | "blocklist"
  | "short_code"
  | "one_time_code"
  | "draft"
  | "spam_trash"
  | "empty";

export interface IngestSummary {
  dryRun: boolean;
  threadsIn: number;
  messagesIn: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Threads that had no message left after filtering (and no stored row): nothing written. */
  emptyThreads: number;
  messagesStored: number;
  skipped: Partial<Record<SkipReason, number>>;
  redactions: number;
  reviewNewParty: number;
  reviewWorkspace: number;
  /** New threads per workspace they were filed under. */
  routed: Record<string, number>;
  errors: string[];
}

export interface IngestOptions {
  owner: OwnerIdentity;
  rules: MessageRules;
  dryRun?: boolean;
  /** import_runs.source; defaults to the threads' source. */
  importSource?: string;
  /** Extra counts recorded in import_runs.counts_in (e.g. what a collector skipped before sending). */
  countsIn?: Record<string, unknown>;
  /** Write the import_runs row (default true). The Gmail sync records one row per run itself. */
  record?: boolean;
  log?: (line: string) => void;
}

export function emptyIngestSummary(dryRun = false): IngestSummary {
  return { dryRun, threadsIn: 0, messagesIn: 0, created: 0, updated: 0, unchanged: 0, emptyThreads: 0, messagesStored: 0, skipped: {}, redactions: 0, reviewNewParty: 0, reviewWorkspace: 0, routed: {}, errors: [] };
}

const GMAIL_CATEGORY_SKIPS: Record<string, SkipReason> = {
  CATEGORY_PROMOTIONS: "category_promotions",
  CATEGORY_SOCIAL: "category_social",
  CATEGORY_UPDATES: "category_updates",
  CATEGORY_FORUMS: "category_forums",
};

/** Why a message must not be stored, or null to keep it. Runs before anything is written. */
export function skipReason(m: MessageInput, thread: Pick<ThreadInput, "source" | "title">, owner: OwnerIdentity, rules: MessageRules): SkipReason | null {
  const labels = m.labels ?? [];
  if (labels.includes("DRAFT")) return "draft";
  if (labels.includes("SPAM") || labels.includes("TRASH")) return "spam_trash";
  for (const l of labels) if (GMAIL_CATEGORY_SKIPS[l]) return GMAIL_CATEGORY_SKIPS[l];
  if (m.listUnsubscribe) return "list_unsubscribe";
  const sender = normalizeIdentifier(m.from);
  if (!m.fromMe && sender && !isOwner(owner, sender)) {
    if (sender.kind === "short_code") return "short_code";
    if (blocked(sender, rules)) return "blocklist";
  }
  if (thread.source === "imessage") {
    if (isOneTimeCode(m.text)) return "one_time_code";
  } else {
    // A verification email is short or says so in its subject. A long email that merely mentions
    // "the building code" and a number keeps its body, with any code-like digit runs redacted.
    const subjectSaysCode = isOneTimeCode(`${thread.title ?? ""} 0000`) && isOneTimeCode(m.text);
    if (subjectSaysCode || (m.text.length <= 800 && isOneTimeCode(`${thread.title ?? ""}\n${m.text}`))) return "one_time_code";
  }
  if (!m.text.trim() && !(m.attachments ?? []).length) return "empty";
  return null;
}

function blocked(id: Identifier, rules: MessageRules): boolean {
  const b = rules.blocklist;
  if (id.kind === "email") return b.emails.has(id.value) || b.domains.has(emailDomain(id.value));
  if (id.kind === "phone") return b.phones.has(id.value);
  return false;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: LOCAL_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: LOCAL_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** "14:05" in America/Chicago. */
export function localTime(d: Date): string {
  return timeFmt.format(d);
}

/** "2026-10-20" in America/Chicago. */
export function localDay(d: Date): string {
  return dayFmt.format(d);
}

/** Title for a text thread: the chat's name, or who it was with, and the local day. */
export function textThreadTitle(chatName: string | null | undefined, names: string[], day: string): string {
  const who = chatName?.trim() || (names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : "unknown");
  return `Texts with ${who} · ${day}`;
}

/** sha256 over the normalised message ids and bodies, in order. */
export function messagesSha(messages: Array<{ id: string; text: string }>): string {
  const h = crypto.createHash("sha256");
  for (const m of [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${m.id}\u0000${m.text.replace(/\r\n/g, "\n").trim()}\u0001`);
  return h.digest("hex");
}

interface StoredMessage {
  id: string;
  sentAt: Date;
  fromMe: boolean;
  /** Normalised identifier value (E.164 / email), or "me". */
  from: string | null;
  fromKind: Identifier["kind"] | "owner" | null;
  fromName: string | null;
  to: string[];
  text: string;
  attachments: MessageAttachment[];
}

export interface PartyRef {
  id: number;
  name: string;
}

export async function matchParties(db: pg.Pool | pg.PoolClient, ids: Identifier[]): Promise<Map<string, PartyRef>> {
  const out = new Map<string, PartyRef>();
  const emails = [...new Set(ids.filter((i) => i.kind === "email").map((i) => i.value))];
  const phones = [...new Set(ids.filter((i) => i.kind === "phone").map((i) => i.value))];
  if (emails.length) {
    const { rows } = await db.query(
      `select p.id, p.name, lower(trim(e)) as key from parties p cross join lateral unnest(p.emails) e where lower(trim(e)) = any($1::text[]) order by p.id`,
      [emails],
    );
    for (const r of rows) if (!out.has(r.key)) out.set(r.key, { id: Number(r.id), name: r.name });
  }
  if (phones.length) {
    const keyToPhone = new Map<string, string>();
    for (const p of phones) for (const k of phoneDigitKeys(p)) keyToPhone.set(k, p);
    const { rows } = await db.query(
      `select p.id, p.name, regexp_replace(ph, '\\D', '', 'g') as key from parties p cross join lateral unnest(p.phones) ph
        where regexp_replace(ph, '\\D', '', 'g') = any($1::text[]) order by p.id`,
      [[...keyToPhone.keys()]],
    );
    for (const r of rows) {
      const phone = keyToPhone.get(r.key);
      if (phone && !out.has(phone)) out.set(phone, { id: Number(r.id), name: r.name });
    }
  }
  return out;
}

export interface RouteDecision {
  workspaceId: string;
  /** Set when the thread went to inbox and needs a human decision. */
  review: { suggested: string | null; candidates: string[]; reason: string } | null;
}

/**
 * The workspace a new thread belongs to. Each matched participant contributes its rule from
 * message_routing.yml, else the workspaces it has a role in (directly, through a current
 * affiliation with an org, or on a project). Email identifiers that contribute nothing fall back
 * to the domain rules. Exactly one workspace wins; anything else, and phalanx always, is inbox.
 */
export async function routeThread(db: pg.Pool | pg.PoolClient, partyIds: number[], emails: string[], partyByEmail: Map<string, PartyRef>, rules: MessageRules, known: Set<string>): Promise<RouteDecision> {
  const perParty = new Map<number, Set<string>>();
  const ruled = partyIds.filter((id) => rules.routing.parties.has(id));
  for (const id of ruled) perParty.set(id, new Set([rules.routing.parties.get(id)!]));
  const rest = partyIds.filter((id) => !rules.routing.parties.has(id));
  if (rest.length) {
    const { rows } = await db.query(
      `select p.party_id, w.workspace_id
         from unnest($1::bigint[]) as p(party_id)
         join lateral (
           select r.workspace_id from roles r where r.party_id = p.party_id
           union select r.workspace_id from affiliations a join roles r on r.party_id = a.org_id where a.person_id = p.party_id and coalesce(a.is_current, true)
           union select pr.workspace_id from project_parties pp join projects pr on pr.id = pp.project_id where pp.party_id = p.party_id
         ) w on true`,
      [rest],
    );
    for (const r of rows) {
      const id = Number(r.party_id);
      const set = perParty.get(id) ?? new Set<string>();
      set.add(r.workspace_id);
      perParty.set(id, set);
    }
  }
  const votes = new Map<string, number>();
  const vote = (ws: string) => {
    if (!known.has(ws) || ws === INBOX) return;
    votes.set(ws, (votes.get(ws) ?? 0) + 1);
  };
  for (const set of perParty.values()) for (const ws of set) vote(ws);
  for (const email of emails) {
    const party = partyByEmail.get(email);
    if (party && (perParty.get(party.id)?.size ?? 0) > 0) continue;
    const ws = rules.routing.domains.get(emailDomain(email));
    if (ws) vote(ws);
  }
  const candidates = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ws]) => ws);
  if (candidates.length === 1 && !NEVER_AUTO_ASSIGNED.includes(candidates[0])) return { workspaceId: candidates[0], review: null };
  if (candidates.length === 1) return { workspaceId: INBOX, review: { suggested: candidates[0], candidates, reason: `Participants map to ${candidates[0]}, which is never assigned automatically` } };
  if (candidates.length > 1) return { workspaceId: INBOX, review: { suggested: candidates[0], candidates, reason: `Participants map to several workspaces: ${candidates.join(", ")}` } };
  return { workspaceId: INBOX, review: { suggested: null, candidates: [], reason: "No participant maps to a workspace" } };
}

interface UnknownSeen {
  identifier: Identifier;
  name: string | null;
  interactionId: number | null;
  source: MessageSource;
}

/** Filters, redacts, matches, routes and writes `threads`. With dryRun nothing is written. */
export async function ingestThreads(pool: pg.Pool, threads: ThreadInput[], opts: IngestOptions): Promise<IngestSummary> {
  const summary = emptyIngestSummary(!!opts.dryRun);
  const log = opts.log ?? (() => {});
  const known = new Set((await pool.query(`select id from workspaces`)).rows.map((r) => r.id as string));
  if (!known.has(INBOX)) throw new Error(`workspace "${INBOX}" does not exist: apply db/migrations/0009_messages.sql`);
  const ownerParty = await findOwnerParty(pool, opts.owner);
  const unknown = new Map<string, UnknownSeen>();

  for (const thread of threads) {
    summary.threadsIn++;
    summary.messagesIn += thread.messages.length;
    try {
      await ingestOne(pool, thread, opts, summary, known, ownerParty, unknown);
    } catch (err) {
      summary.errors.push(`${thread.sourceRef}: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  if (!opts.dryRun) {
    for (const u of unknown.values()) {
      try {
        if (await queueNewParty(pool, u)) summary.reviewNewParty++;
      } catch (err) {
        summary.errors.push(`review ${u.identifier.kind}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    if (opts.record !== false) await recordImportRun(pool, opts.importSource ?? threads[0]?.source ?? "messages", summary, opts.countsIn);
  } else {
    for (const u of unknown.values()) {
      const seen = await pool.query(`select 1 from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = $1 limit 1`, [u.identifier.value]);
      if (!seen.rowCount) summary.reviewNewParty++;
    }
  }
  log(
    `messages: ${summary.threadsIn} thread(s), ${summary.messagesIn} message(s) in; ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged; ` +
      `skipped ${Object.entries(summary.skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${summary.redactions} redaction(s); ` +
      `${summary.reviewNewParty} unknown sender(s) and ${summary.reviewWorkspace} workspace decision(s) queued${summary.dryRun ? " (dry run, nothing written)" : ""}`,
  );
  return summary;
}

/** One import_runs row: what came in, and what was written, skipped (per reason) and queued. */
export async function recordImportRun(pool: pg.Pool, source: string, s: IngestSummary, countsIn: Record<string, unknown> = {}): Promise<void> {
  await pool.query(`insert into import_runs (source, counts_in, counts_out, finished_at, ok) values ($1, $2::jsonb, $3::jsonb, now(), $4)`, [
    source,
    JSON.stringify({ threads: s.threadsIn, messages: s.messagesIn, ...countsIn }),
    JSON.stringify(countsOut(s)),
    s.errors.length === 0,
  ]);
}

/** Adds `b`'s counts into `a`. */
export function mergeIngestSummary(a: IngestSummary, b: IngestSummary): IngestSummary {
  for (const k of ["threadsIn", "messagesIn", "created", "updated", "unchanged", "emptyThreads", "messagesStored", "redactions", "reviewNewParty", "reviewWorkspace"] as const) a[k] += b[k];
  for (const [k, v] of Object.entries(b.skipped)) a.skipped[k as SkipReason] = (a.skipped[k as SkipReason] ?? 0) + (v ?? 0);
  for (const [k, v] of Object.entries(b.routed)) a.routed[k] = (a.routed[k] ?? 0) + v;
  a.errors.push(...b.errors);
  return a;
}

export function countsOut(s: IngestSummary): Record<string, unknown> {
  return {
    created: s.created,
    updated: s.updated,
    unchanged: s.unchanged,
    empty_threads: s.emptyThreads,
    messages_stored: s.messagesStored,
    skipped: s.skipped,
    redactions: s.redactions,
    review_new_party: s.reviewNewParty,
    review_workspace: s.reviewWorkspace,
    routed: s.routed,
    errors: s.errors.length,
  };
}

export async function findOwnerParty(pool: pg.Pool, owner: OwnerIdentity): Promise<PartyRef | null> {
  const ids: Identifier[] = [...[...owner.emails].map((value) => ({ kind: "email" as const, value })), ...[...owner.phones].map((value) => ({ kind: "phone" as const, value }))];
  if (!ids.length) return null;
  const m = await matchParties(pool, ids);
  for (const id of ids) if (m.has(id.value)) return m.get(id.value)!;
  return null;
}

/** Postgres text and jsonb cannot hold NUL; message bodies occasionally do. */
const clean = (s: string) => s.replace(/\u0000/g, "");

function toStored(m: MessageInput, owner: OwnerIdentity, thread: ThreadInput, counter: { redactions: number }): StoredMessage {
  const sender = normalizeIdentifier(m.from);
  const fromMe = m.fromMe || isOwner(owner, sender);
  let text = clean(m.text).replace(/\r\n/g, "\n").trim();
  if (thread.source === "gmail") {
    const otp = redactOneTimeCodes(text);
    text = otp.text;
    counter.redactions += otp.count;
  }
  const r = redactSensitive(text);
  counter.redactions += r.count;
  const name = m.fromName ? redactSensitive(clean(m.fromName).trim()).text.slice(0, 200) || null : null;
  const attachments = (m.attachments ?? []).map((a) => ({
    filename: a.filename ? redactSensitive(clean(a.filename)).text.slice(0, 300) : null,
    mime: a.mime ? String(a.mime).slice(0, 120) : null,
    size: Number.isFinite(a.size) ? Number(a.size) : null,
  }));
  const to = (m.to ?? [])
    .map((t) => normalizeIdentifier(t))
    .filter((t): t is Identifier => !!t && (t.kind === "email" || t.kind === "phone"))
    .map((t) => t.value);
  return {
    id: String(m.id),
    sentAt: m.sentAt,
    fromMe,
    from: fromMe ? (sender && sender.kind !== "other" ? sender.value : "me") : sender?.value ?? null,
    fromKind: fromMe ? "owner" : sender?.kind ?? null,
    fromName: fromMe ? null : name,
    to,
    text: r.text,
    attachments,
  };
}

async function loadExisting(db: pg.Pool | pg.PoolClient, thread: ThreadInput) {
  const { rows } = await db.query(`select id, workspace_id, content_sha256, source_payload from interactions where source = $1 and source_ref = $2`, [thread.source, thread.sourceRef]);
  const row = rows[0];
  if (!row) return null;
  const segs = await db.query(`select idx, text from segments where interaction_id = $1`, [row.id]);
  const textByIdx = new Map(segs.rows.map((s) => [Number(s.idx), s.text as string]));
  const payloadMessages = ((row.source_payload ?? {}).messages ?? []) as Array<Record<string, unknown>>;
  const messages: StoredMessage[] = payloadMessages.map((p) => ({
    id: String(p.id),
    sentAt: new Date(String(p.sent_at)),
    fromMe: !!p.from_me,
    from: (p.from as string | null) ?? null,
    fromKind: (p.from_kind as StoredMessage["fromKind"]) ?? null,
    fromName: (p.from_name as string | null) ?? null,
    to: (p.to as string[] | undefined) ?? [],
    text: p.attachments_only ? "" : textByIdx.get(Number(p.idx)) ?? "",
    attachments: (p.attachments as MessageAttachment[] | undefined) ?? [],
  }));
  return { id: Number(row.id), workspaceId: row.workspace_id as string | null, sha: row.content_sha256 as string | null, messages, payload: row.source_payload ?? {} };
}

async function ingestOne(
  pool: pg.Pool,
  thread: ThreadInput,
  opts: IngestOptions,
  summary: IngestSummary,
  known: Set<string>,
  ownerParty: PartyRef | null,
  unknown: Map<string, UnknownSeen>,
): Promise<void> {
  const counter = { redactions: 0 };
  const kept: StoredMessage[] = [];
  for (const m of thread.messages) {
    const reason = skipReason(m, thread, opts.owner, opts.rules);
    if (reason) {
      summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
      continue;
    }
    kept.push(toStored(m, opts.owner, thread, counter));
  }
  summary.redactions += counter.redactions;
  const existing = await loadExisting(pool, thread);
  if (!kept.length && !existing) {
    summary.emptyThreads++;
    return;
  }

  // Merge by message id: what arrived now replaces what was stored for the same id.
  const byId = new Map<string, StoredMessage>();
  for (const m of existing?.messages ?? []) byId.set(m.id, m);
  for (const m of kept) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || (a.id < b.id ? -1 : 1));
  const sha = messagesSha(messages);
  if (existing && existing.sha === sha) {
    summary.unchanged++;
    return;
  }

  // Identify everyone: senders, Ben's recipients, chat members.
  const identifiers = new Map<string, { id: Identifier; name: string | null }>();
  const addId = (raw: string | null | undefined, name: string | null | undefined) => {
    const id = normalizeIdentifier(raw);
    if (!id || (id.kind !== "phone" && id.kind !== "email") || isOwner(opts.owner, id)) return;
    const prev = identifiers.get(id.value);
    if (!prev) identifiers.set(id.value, { id, name: name?.trim() || null });
    else if (!prev.name && name?.trim()) prev.name = name.trim();
  };
  for (const m of messages) {
    if (!m.fromMe) addId(m.from, m.fromName);
    else for (const t of m.to) addId(t, null);
  }
  for (const p of thread.participants ?? []) addId(p.identifier, p.name ?? null);
  const parties = await matchParties(pool, [...identifiers.values()].map((v) => v.id));

  const counts = new Map<string, number>();
  for (const m of messages) if (!m.fromMe && m.from) counts.set(m.from, (counts.get(m.from) ?? 0) + 1);
  const participantsRaw = [...identifiers.values()].map((v) => ({
    identifier: v.id.value,
    kind: v.id.kind,
    name: v.name ? redactSensitive(v.name).text : null,
    party_id: parties.get(v.id.value)?.id ?? null,
    messages: counts.get(v.id.value) ?? 0,
  }));

  const speakerOf = (m: StoredMessage): { name: string; partyId: number | null } => {
    if (m.fromMe) return { name: opts.owner.name, partyId: ownerParty?.id ?? null };
    const party = m.from ? parties.get(m.from) : undefined;
    return { name: m.fromName || party?.name || m.from || "Unknown", partyId: party?.id ?? null };
  };
  const t0 = messages.length ? messages[0].sentAt.getTime() : Date.now();
  const segments = messages.map((m, idx) => {
    const sp = speakerOf(m);
    const start = Math.max(0, (m.sentAt.getTime() - t0) / 1000);
    const body = m.text.trim() || `[attachment: ${m.attachments.map((a) => a.filename ?? a.mime ?? "file").join(", ")}]`;
    return { idx, start, speaker: sp.name, partyId: sp.partyId, text: body, attachmentsOnly: !m.text.trim() };
  });
  const transcript = segments.map((s, i) => `[${localTime(messages[i].sentAt)}] ${s.speaker}: ${s.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
  const rawTitle =
    thread.title ??
    (thread.kind === "text_thread"
      ? textThreadTitle(
          thread.meta?.chat_name as string | null | undefined,
          participantsRaw.map((p) => (p.party_id ? parties.get(p.identifier)?.name : null) || p.name || p.identifier),
          String(thread.meta?.local_date ?? (messages[0] ? localDay(messages[0].sentAt) : "")),
        )
      : null);
  const title = redactOneTimeCodes(redactSensitive(clean(rawTitle ?? "")).text).text.slice(0, 300) || null;
  const attachmentsTotal = messages.reduce((n, m) => n + m.attachments.length, 0);
  const sourcePayload = {
    ...(existing?.payload ?? {}),
    ...(thread.meta ?? {}),
    timezone: LOCAL_TIMEZONE,
    message_count: messages.length,
    attachments_total: attachmentsTotal,
    messages: messages.map((m, idx) => ({
      idx,
      id: m.id,
      sent_at: m.sentAt.toISOString(),
      from_me: m.fromMe,
      from: m.from,
      from_kind: m.fromKind,
      from_name: m.fromName,
      ...(m.to.length ? { to: m.to } : {}),
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
      ...(segments[idx].attachmentsOnly ? { attachments_only: true } : {}),
    })),
  };

  // Unknown identifiers: queued once each, after the writes (counts come from the stored rows).
  const rememberUnknown = (interactionId: number | null) => {
    for (const v of identifiers.values()) {
      if (parties.has(v.id.value)) continue;
      const wrote = (counts.get(v.id.value) ?? 0) > 0;
      const benWroteTo = messages.some((m) => m.fromMe && m.to.includes(v.id.value));
      const member = (thread.participants ?? []).some((p) => normalizeIdentifier(p.identifier)?.value === v.id.value);
      if (!wrote && !benWroteTo && !member) continue;
      const prev = unknown.get(v.id.value);
      if (!prev) unknown.set(v.id.value, { identifier: v.id, name: v.name, interactionId, source: thread.source });
      else if (!prev.name && v.name) prev.name = v.name;
    }
  };

  const partyIds = [...new Set(participantsRaw.map((p) => p.party_id).filter((x): x is number => x !== null))];
  if (opts.dryRun) {
    if (existing) summary.updated++;
    else {
      summary.created++;
      const route = await routeThread(pool, partyIds, participantsRaw.filter((p) => p.kind === "email").map((p) => p.identifier), parties, opts.rules, known);
      summary.routed[route.workspaceId] = (summary.routed[route.workspaceId] ?? 0) + 1;
      if (route.review?.suggested) summary.reviewWorkspace++;
    }
    summary.messagesStored += messages.length - (existing?.messages.length ?? 0);
    rememberUnknown(existing?.id ?? null);
    return;
  }

  const db = await pool.connect();
  try {
    await db.query("begin");
    let route: RouteDecision | null = null;
    if (!existing) route = await routeThread(db, partyIds, participantsRaw.filter((p) => p.kind === "email").map((p) => p.identifier), parties, opts.rules, known);
    const ins = await db.query<{ id: number; inserted: boolean; workspace_id: string | null }>(
      `insert into interactions (workspace_id, kind, occurred_at, title, transcript, source, source_ref, content_sha256, participants_raw, source_payload, pipeline_status, pipeline_updated_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'ready', now(), now())
       on conflict (source, source_ref) where source_ref is not null do update set
         occurred_at = excluded.occurred_at, title = excluded.title, transcript = excluded.transcript,
         content_sha256 = excluded.content_sha256, participants_raw = excluded.participants_raw, source_payload = excluded.source_payload,
         pipeline_status = 'ready', pipeline_error = null, pipeline_updated_at = now(), updated_at = now(),
         embed_attempts = 0, embed_error = null
       returning id, (xmax = 0) as inserted, workspace_id`,
      [
        route?.workspaceId ?? existing?.workspaceId ?? INBOX,
        thread.kind,
        messages[0]?.sentAt ?? null,
        title,
        transcript,
        thread.source,
        thread.sourceRef,
        sha,
        JSON.stringify(participantsRaw),
        JSON.stringify(sourcePayload),
      ],
    );
    const interactionId = Number(ins.rows[0].id);
    const inserted = ins.rows[0].inserted;

    await db.query(`delete from segments where interaction_id = $1`, [interactionId]);
    const BATCH = 200;
    for (let i = 0; i < segments.length; i += BATCH) {
      const slice = segments.slice(i, i + BATCH);
      const params: unknown[] = [];
      const values = slice.map((s) => {
        params.push(interactionId, s.idx, s.start, s.start, s.speaker, s.partyId, s.text);
        const b = params.length - 7;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      });
      await db.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, speaker_party_id, text) values ${values.join(", ")}`, params);
    }

    const linked = [...partyIds.map((id) => ({ id, label: participantsRaw.find((p) => p.party_id === id)?.name ?? null })), ...(ownerParty ? [{ id: ownerParty.id, label: opts.owner.name }] : [])];
    for (const l of linked) {
      await db.query(`insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values ($1, $2, $3, 1) on conflict (interaction_id, party_id) do nothing`, [interactionId, l.id, l.label]);
    }

    if (route?.review?.suggested) {
      const dup = await db.query(`select 1 from review_queue where item_type = 'workspace_assignment' and interaction_id = $1`, [interactionId]);
      if (!dup.rowCount) {
        await db.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('workspace_assignment', $1::jsonb, $2, $3, 'open')`, [
          JSON.stringify({ interaction_id: interactionId, workspace_id: route.review.suggested, candidates: route.review.candidates, source: "messages", proposed_at: new Date().toISOString() }),
          route.review.reason,
          interactionId,
        ]);
        summary.reviewWorkspace++;
      }
    }
    await db.query("commit");
    if (inserted) {
      summary.created++;
      const ws = ins.rows[0].workspace_id ?? INBOX;
      summary.routed[ws] = (summary.routed[ws] ?? 0) + 1;
    } else summary.updated++;
    summary.messagesStored += messages.length - (existing?.messages.length ?? 0);
    rememberUnknown(interactionId);
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/**
 * One new_party review row per unknown identifier, ever: an open row gets fresh counts, a decided
 * one is left alone (a rejected sender is not proposed again). Counts come from the stored threads,
 * so re-imports do not inflate them.
 */
async function queueNewParty(pool: pg.Pool, u: UnknownSeen): Promise<boolean> {
  const stats = await pool.query(
    `select count(*)::int as n, min((m->>'sent_at')::timestamptz) as first_seen, max((m->>'sent_at')::timestamptz) as last_seen,
            array_agg(distinct i.source) as sources
       from interactions i cross join lateral jsonb_array_elements(i.source_payload->'messages') m
      where i.kind = any($2::text[]) and i.participants_raw @> $3::jsonb and m->>'from' = $1`,
    [u.identifier.value, MESSAGE_KINDS, JSON.stringify([{ identifier: u.identifier.value }])],
  );
  const s = stats.rows[0] ?? {};
  const evidence = {
    identifier: u.identifier.value,
    identifier_kind: u.identifier.kind,
    display_name: u.name,
    message_count: Number(s.n ?? 0),
    first_seen: s.first_seen ? new Date(s.first_seen).toISOString() : null,
    last_seen: s.last_seen ? new Date(s.last_seen).toISOString() : null,
    sources: (s.sources ?? [u.source]).filter(Boolean),
  };
  const existing = await pool.query(`select id, status from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = $1 order by id limit 1`, [u.identifier.value]);
  if (existing.rows[0]) {
    if (existing.rows[0].status === "open") {
      await pool.query(`update review_queue set proposal = jsonb_set(proposal, '{evidence}', $2::jsonb) where id = $1`, [existing.rows[0].id, JSON.stringify(evidence)]);
    }
    return false;
  }
  const name = u.name || u.identifier.value;
  const proposal = {
    kind: "person",
    name,
    ...(u.identifier.kind === "email" ? { emails: [u.identifier.value] } : { phones: [u.identifier.value] }),
    source: "messages",
    proposed_at: new Date().toISOString(),
    evidence,
  };
  await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('new_party', $1::jsonb, $2, $3, 'open')`, [
    JSON.stringify(proposal),
    `Unknown ${u.identifier.kind === "email" ? "email sender" : "phone number"} in ${evidence.sources.includes("gmail") ? "email" : "texts"}: ${name}${u.name ? ` (${u.identifier.value})` : ""}, ${evidence.message_count} message(s)`,
    u.interactionId,
  ]);
  return true;
}
