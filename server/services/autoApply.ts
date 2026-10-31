// Context-aware auto-approval (docs/AUTO-APPLY.md). Every proposal still lands in review_queue
// first; these rules then decide whether it applies at once or waits for Ben:
//
//   AUTO-APPLY when all hold
//     - source: it cites a recording/thread, and a quote that is really in it, a timestamp that
//       lands on a line of it, or the proposed values themselves appear in it verbatim
//     - additive: new_party (no role), adding a phone/email to a party that has none of that kind,
//       link_party_interaction, link_project_interaction, new_fact of kind commitment / task /
//       followup / price quoted in the source
//     - confidence >= AUTO_APPLY_MIN_CONFIDENCE (0.85); 0.9 when unset and the values are verbatim
//     - no conflict: changes no existing name/phone/email/label, matches no other party by
//       phone, email or exact name
//   QUEUE otherwise, with the first rule that held it back.
//
// Applying goes through the same appliers as the Review page's Approve, in one transaction with
// the evaluation, and writes an auto_applies row: what changed, the rule, the source quote and
// the steps that undo it.
import type pg from "pg";
import { APPLIERS, listReviewById, type ReviewItem } from "./review.ts";
import { runUndo, UndoError, type UndoOp } from "./undo.ts";
import type { ProposalType } from "../mcp/tools/propose.ts";

export const DEFAULT_MIN_CONFIDENCE = 0.85;
/** Confidence assumed when none was given and every proposed value is verbatim in the source. */
export const VERBATIM_CONFIDENCE = 0.9;
/** Fact kinds that are a record of what was said; decision, issue, preference and other are judgement calls. */
export const AUTO_FACT_KINDS = ["commitment", "task", "followup", "price"];

export interface RouteDecision {
  auto: boolean;
  /** The rule that allowed it, or the first one that held it back. */
  rule: string;
  /** Everything that held it back (empty when auto). */
  reasons: string[];
  /** The verified quote, or the line of the source the verbatim values were found in. */
  quote: string | null;
  confidence: number | null;
  interactionId: number | null;
}

export interface RouteOptions {
  minConfidence?: number;
}

type Db = pg.Pool | pg.PoolClient;

interface Item {
  itemType: string;
  proposal: Record<string, unknown>;
  reason: string | null;
  interactionId: number | null;
}

// ---- text matching -----------------------------------------------------------

/** Lowercase, straight quotes, letters and digits only, single spaces: how quotes and names are compared. */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/(?<!\p{L})'|'(?!\p{L})/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const digits = (s: string) => s.replace(/\D/g, "");
/** The last ten digits: +1 (615) 555-0142, 615.555.0142 and 6155550142 are one number. */
export function phoneKey(s: string): string {
  const d = digits(s);
  return d.length > 10 ? d.slice(-10) : d;
}

interface Source {
  interactionId: number;
  lines: Array<{ text: string; start: number; end: number }>;
  normText: string;
  /** Lowercased raw text, for email addresses (normalize() would split them). */
  lowerText: string;
  phones: Set<string>;
}

async function loadSource(db: Db, interactionId: number): Promise<Source | null> {
  const i = await db.query(`select id, transcript from interactions where id = $1`, [interactionId]);
  if (!i.rows[0]) return null;
  const seg = await db.query<{ text: string; start_sec: number; end_sec: number }>(`select text, start_sec, end_sec from segments where interaction_id = $1 order by idx`, [interactionId]);
  // The words said or written: transcript lines, or message bodies. Header metadata (a sender's display
  // name or number) is not the source: it is how most unknown senders look, newsletters included.
  const lines = seg.rows.length
    ? seg.rows.map((r) => ({ text: r.text, start: Number(r.start_sec), end: Number(r.end_sec) }))
    : i.rows[0].transcript
      ? String(i.rows[0].transcript)
          .split(/\n+/)
          .map((t) => ({ text: t, start: -1, end: -1 }))
      : [];
  const raw = lines.map((l) => l.text).join("\n");
  const phones = new Set<string>();
  for (const m of raw.matchAll(/\+?\d[\d\s().-]{5,}\d/g)) {
    const k = phoneKey(m[0]);
    if (k.length >= 7) phones.add(k);
  }
  return { interactionId, lines, normText: ` ${normalize(raw)} `, lowerText: raw.toLowerCase(), phones };
}

function has(src: Source, value: string): boolean {
  const n = normalize(value);
  return n.length > 0 && src.normText.includes(` ${n} `);
}
function hasPhone(src: Source, value: string): boolean {
  const k = phoneKey(value);
  return k.length >= 7 && src.phones.has(k);
}
function hasEmail(src: Source, value: string): boolean {
  const e = value.trim().toLowerCase();
  if (!e.includes("@")) return false;
  let i = src.lowerText.indexOf(e);
  while (i >= 0) {
    const before = src.lowerText[i - 1] ?? " ";
    const after = src.lowerText[i + e.length] ?? " ";
    if (!/[a-z0-9._%+-]/.test(before) && !/[a-z0-9_%+-]/.test(after)) return true;
    i = src.lowerText.indexOf(e, i + 1);
  }
  return false;
}
/** The source line a value was found on, for the audit log. */
function lineWith(src: Source, test: (line: string) => boolean): string | null {
  const line = src.lines.find((l) => test(l.text));
  return line ? line.text.trim().slice(0, 400) : null;
}

/** Dollar amounts written in a text: "$12,500", "12500", "12.5k", "$1.2 million". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\b/gi)) {
    let n = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k" || unit === "thousand") n *= 1000;
    if (unit === "m" || unit === "million") n *= 1_000_000;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The quote a proposal cites: the agent's source_quote, the extractor's “quote” at m:ss reason, or evidence.quote. */
function citedQuote(item: Item): string | null {
  const p = item.proposal;
  if (typeof p.source_quote === "string" && p.source_quote.trim()) return p.source_quote.trim();
  const ev = p.evidence as { quote?: unknown } | undefined;
  if (typeof ev?.quote === "string" && ev.quote.trim()) return ev.quote.trim();
  const m = item.reason?.match(/^“(.+)” at /);
  return m ? m[1] : null;
}

// ---- the rules -----------------------------------------------------------------

export async function evaluateProposal(db: Db, item: Item, opts: RouteOptions = {}): Promise<RouteDecision> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const p = item.proposal;
  const interactionId = item.interactionId ?? (typeof p.interaction_id === "number" ? p.interaction_id : null);
  const reasons: string[] = [];
  const hold = (rule: string) => reasons.push(rule);
  const decision = (auto: boolean, rule: string, quote: string | null, confidence: number | null): RouteDecision => ({
    auto,
    rule: auto ? rule : reasons[0],
    reasons: auto ? [] : reasons,
    quote,
    confidence,
    interactionId,
  });

  // 1. What kind of change is it? Inferences, edits and anything outside the additive set queue.
  const type = item.itemType;
  if (type === "new_relationship") hold("inference:relationship");
  else if (type === "new_fact" && !AUTO_FACT_KINDS.includes(String(p.kind))) hold(`inference:fact-${String(p.kind)}`);
  else if (type === "new_party" && p.role) hold("inference:role");
  else if (type === "party_edit") {
    const changes = (p.changes ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(changes)) if (k !== "phones" && k !== "emails") hold(`edits-existing:${k}`);
  } else if (!["new_party", "link_party_interaction", "link_project_interaction", "new_fact"].includes(type)) hold(`not-additive:${type}`);
  if (reasons.length) return decision(false, "", null, num(p.confidence));

  // 2. Source context.
  const src = interactionId ? await loadSource(db, interactionId) : null;
  if (!src) {
    hold("no-source");
    return decision(false, "", null, num(p.confidence));
  }
  const quote = citedQuote(item);
  const quoteOk = !!quote && normalize(quote).length >= 8 && has(src, quote);
  const at = num(p.quote_start_sec ?? p.start_sec);
  const stampOk = at !== null && src.lines.some((l) => l.start >= 0 && l.start - 5 <= at && at <= l.end + 5);

  // 3. Per type: the values that must be verbatim, and conflicts with what is stored.
  let verbatim = false;
  let found: string | null = null;
  let rule = "";
  if (type === "new_party") {
    rule = "additive:new-party-verbatim";
    const name = String(p.name ?? "");
    const emails = (p.emails as string[] | undefined) ?? [];
    const phones = (p.phones as string[] | undefined) ?? [];
    // Contact details and the name must be in the words of the source; an agent relaying them is not enough.
    if (!has(src, name)) hold("not-verbatim:name");
    for (const e of emails) if (!hasEmail(src, e)) hold("not-verbatim:email");
    for (const ph of phones) if (!hasPhone(src, ph)) hold("not-verbatim:phone");
    for (const k of ["location", "website"] as const) if (typeof p[k] === "string" && p[k] && !has(src, p[k] as string)) hold(`not-verbatim:${k}`);
    verbatim = !reasons.length;
    found = lineWith(src, (l) => normalize(l).includes(normalize(name)));
    await duplicateChecks(db, { name, kind: String(p.kind ?? "person"), emails, phones }, null, hold);
  } else if (type === "party_edit") {
    rule = "additive:contact-added";
    const partyId = Number(p.party_id);
    const changes = p.changes as { emails?: string[]; phones?: string[] };
    const { rows } = await db.query(`select emails, phones, merged_into from parties where id = $1`, [partyId]);
    if (!rows[0]) hold("unknown-party");
    else {
      if (rows[0].merged_into) hold("edits-existing:merged-party");
      const have = { emails: ((rows[0].emails as string[] | null) ?? []).map((e) => e.toLowerCase()), phones: ((rows[0].phones as string[] | null) ?? []).map(phoneKey) };
      const newEmails = (changes.emails ?? []).filter((e) => !have.emails.includes(e.toLowerCase()));
      const newPhones = (changes.phones ?? []).filter((ph) => !have.phones.includes(phoneKey(ph)));
      // A party that already has a phone (email) getting another is read as a possible replacement: Ben decides.
      if (newPhones.length && have.phones.length) hold("edits-existing:phone");
      if (newEmails.length && have.emails.length) hold("edits-existing:email");
      for (const e of newEmails) if (!hasEmail(src, e)) hold("not-verbatim:email");
      for (const ph of newPhones) if (!hasPhone(src, ph)) hold("not-verbatim:phone");
      verbatim = !reasons.length;
      const first = newPhones[0] ?? newEmails[0];
      found = first ? lineWith(src, (l) => (newPhones[0] ? [...l.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].some((m) => phoneKey(m[0]) === phoneKey(first)) : l.toLowerCase().includes(first.toLowerCase()))) : null;
      await duplicateChecks(db, { emails: newEmails, phones: newPhones }, partyId, hold);
    }
  } else if (type === "link_party_interaction") {
    rule = "additive:link-party";
    const partyId = Number(p.party_id);
    const label = typeof p.speaker_label === "string" ? p.speaker_label : null;
    const party = await db.query(`select name, emails, phones, merged_into from parties where id = $1`, [partyId]);
    if (!party.rows[0]) hold("unknown-party");
    else {
      if (party.rows[0].merged_into) hold("edits-existing:merged-party");
      const name = String(party.rows[0].name);
      const contacts = [...((party.rows[0].phones as string[] | null) ?? []).filter((ph) => hasPhone(src, ph)), ...((party.rows[0].emails as string[] | null) ?? []).filter((e) => hasEmail(src, e))];
      verbatim = has(src, name) || contacts.length > 0;
      found = lineWith(src, (l) => normalize(l).includes(normalize(name)));
      const prior = await db.query(`select speaker_label from interaction_participants where interaction_id = $1 and party_id = $2`, [src.interactionId, partyId]);
      if (prior.rows[0] && label && prior.rows[0].speaker_label && prior.rows[0].speaker_label !== label) hold("edits-existing:speaker-label");
      if (label) {
        const taken = await db.query(
          `select 1 from interaction_participants where interaction_id = $1 and speaker_label = $2 and party_id <> $3
           union all select 1 from segments where interaction_id = $1 and speaker = $2 and speaker_party_id is not null and speaker_party_id <> $3 limit 1`,
          [src.interactionId, label, partyId],
        );
        if (taken.rowCount) hold("conflict:speaker-label-taken");
      }
    }
  } else if (type === "link_project_interaction") {
    rule = "additive:link-project";
    const proj = await db.query(`select name, address from projects where id = $1`, [p.project_id]);
    if (!proj.rows[0]) hold("unknown-project");
    else {
      const name = String(proj.rows[0].name);
      const address = proj.rows[0].address ? String(proj.rows[0].address) : null;
      verbatim = has(src, name) || (!!address && has(src, address));
      found = lineWith(src, (l) => normalize(l).includes(normalize(name)) || (!!address && normalize(l).includes(normalize(address))));
    }
  } else if (type === "new_fact") {
    rule = `additive:fact-${String(p.kind)}-quoted`;
    // A fact is auto-applied only when what it rests on was really said: a verified quote, or its text verbatim.
    const textVerbatim = has(src, String(p.text ?? ""));
    if (!quoteOk && !textVerbatim) hold(quote ? "quote-not-in-source" : "not-quoted");
    if (p.kind === "price" && typeof p.amount === "number") {
      const where = quoteOk ? quote! : src.lines.map((l) => l.text).join("\n");
      if (!amountsIn(where).some((a) => Math.abs(a - (p.amount as number)) < 0.005)) hold("not-verbatim:amount");
    }
    verbatim = !reasons.length;
  }
  if (quote && !quoteOk && !reasons.includes("quote-not-in-source")) hold("quote-not-in-source");
  // Nothing ties it to the cited conversation: no quote found in it, no line at the timestamp, no value in its words.
  if (!quoteOk && !stampOk && !verbatim && !reasons.length) hold("no-source");

  // 4. Confidence.
  const given = num(p.confidence);
  const confidence = given ?? (verbatim ? VERBATIM_CONFIDENCE : null);
  if (confidence === null) hold("confidence-unknown");
  else if (confidence < minConfidence) hold(`low-confidence:${confidence.toFixed(2)}`);

  if (reasons.length) return decision(false, "", quoteOk ? quote : found, confidence);
  return decision(true, rule, quoteOk ? quote : found, confidence);
}

/** Another party with the same phone, email or (same kind) exact name: a possible duplicate, Ben merges or not. */
async function duplicateChecks(db: Db, v: { name?: string; kind?: string; emails: string[]; phones: string[] }, selfId: number | null, hold: (r: string) => void): Promise<void> {
  if (v.phones.length) {
    const { rows } = await db.query<{ phones: string[] }>(`select phones from parties where phones <> '{}' and merged_into is null and ($1::bigint is null or id <> $1)`, [selfId]);
    const keys = new Set(v.phones.map(phoneKey));
    if (rows.some((r) => (r.phones ?? []).some((ph) => keys.has(phoneKey(ph))))) hold("possible-duplicate:phone");
  }
  if (v.emails.length) {
    const { rowCount } = await db.query(
      `select 1 from parties where merged_into is null and ($2::bigint is null or id <> $2) and exists (select 1 from unnest(emails) e where lower(e) = any($1::text[])) limit 1`,
      [v.emails.map((e) => e.toLowerCase()), selfId],
    );
    if (rowCount) hold("possible-duplicate:email");
  }
  if (v.name) {
    const { rowCount } = await db.query(`select 1 from parties where merged_into is null and kind = $2 and lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = $1 limit 1`, [
      v.name.trim().replace(/\s+/g, " ").toLowerCase(),
      v.kind ?? "person",
    ]);
    if (rowCount) hold("possible-duplicate:name");
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ---- applying ------------------------------------------------------------------

export interface RouteResult {
  applied: boolean;
  rule: string;
  reviewId: number;
  autoApplyId?: number;
  changed?: string[];
  reasons?: string[];
}

const UNAVAILABLE = new Set(["42P01", "42703"]); // undefined_table / undefined_column: 0014 not applied yet

/**
 * Evaluates one open review item and, when the rules allow it, applies it and logs it, all in one
 * transaction on `client` (the caller's, so the extractor can route inside its own). Never throws for
 * a proposal that cannot apply: the item stays open with the reason.
 */
export async function routeReviewItem(client: pg.PoolClient, reviewId: number, opts: RouteOptions & { actor: string; enabled?: boolean }): Promise<RouteResult> {
  await client.query("savepoint auto_route");
  try {
    const { rows } = await client.query(`select * from review_queue where id = $1 for update`, [reviewId]);
    const row = rows[0];
    if (!row || row.status !== "open") {
      await client.query("release savepoint auto_route");
      return { applied: false, rule: row ? `already-${String(row.status)}` : "not-found", reviewId };
    }
    const d = await evaluateProposal(client, { itemType: row.item_type, proposal: row.proposal ?? {}, reason: row.reason, interactionId: row.interaction_id == null ? null : Number(row.interaction_id) }, opts);
    if (d.auto && opts.enabled === false) {
      d.auto = false;
      d.reasons = ["auto-apply-off"];
      d.rule = "auto-apply-off";
    }
    await client.query(`update review_queue set route = $2::jsonb where id = $1`, [reviewId, JSON.stringify({ ...d, evaluated_at: new Date().toISOString() })]);
    if (!d.auto) {
      await client.query("release savepoint auto_route");
      return { applied: false, rule: d.rule, reasons: d.reasons, reviewId };
    }
    const undo: UndoOp[] = [];
    let changed: string[];
    await client.query("savepoint auto_apply");
    try {
      changed = await APPLIERS[row.item_type as ProposalType](client, row.proposal ?? {}, row, undo);
    } catch (err) {
      // The applier refused (a row vanished, the shape no longer holds): leave it for Ben, with why.
      await client.query("rollback to savepoint auto_apply");
      const why = `apply-failed:${(err as Error).message.slice(0, 200)}`;
      await client.query(`update review_queue set route = jsonb_set(route, '{reasons}', $2::jsonb) where id = $1`, [reviewId, JSON.stringify([why])]);
      await client.query("release savepoint auto_route");
      return { applied: false, rule: "apply-failed", reasons: [why], reviewId };
    }
    await client.query(`update review_queue set status = 'approved', decided_at = now(), decided_by = 'auto' where id = $1`, [reviewId]);
    const ins = await client.query<{ id: number }>(
      `insert into auto_applies (review_id, item_type, rule, source_interaction_id, source_quote, confidence, applied, undo, actor)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning id`,
      [reviewId, row.item_type, d.rule, d.interactionId, d.quote, d.confidence, changed, JSON.stringify(undo), opts.actor],
    );
    await client.query("release savepoint auto_route");
    return { applied: true, rule: d.rule, reviewId, autoApplyId: Number(ins.rows[0].id), changed };
  } catch (err) {
    await client.query("rollback to savepoint auto_route").catch(() => {});
    if (UNAVAILABLE.has((err as { code?: string }).code ?? "")) return { applied: false, rule: "auto-apply-unavailable", reasons: ["db/migrations/0014_auto_apply.sql is not applied"], reviewId };
    throw err;
  }
}

/** routeReviewItem in its own transaction. */
export async function routeReviewItemTx(pool: pg.Pool, reviewId: number, opts: RouteOptions & { actor: string; enabled?: boolean }): Promise<RouteResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await routeReviewItem(client, reviewId, opts);
    await client.query("commit");
    return r;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- the log and undo -------------------------------------------------------------

export interface AutoApplied {
  id: number;
  reviewId: number;
  itemType: string;
  rule: string;
  sourceQuote: string | null;
  confidence: number | null;
  applied: string[];
  actor: string | null;
  createdAt: string;
  undoneAt: string | null;
  undoneBy: string | null;
  item: ReviewItem | null;
}

export async function listAutoApplied(pool: pg.Pool, f: { days?: number; workspaceId?: string | null; limit?: number } = {}): Promise<AutoApplied[]> {
  const { rows } = await pool.query(
    `select a.* from auto_applies a left join interactions i on i.id = a.source_interaction_id
      where a.created_at > now() - make_interval(days => $1) and ($2::text is null or i.workspace_id = $2)
      order by a.created_at desc, a.id desc limit $3`,
    [f.days ?? 7, f.workspaceId ?? null, Math.min(Math.max(f.limit ?? 200, 1), 500)],
  );
  const out: AutoApplied[] = [];
  for (const r of rows) {
    out.push({
      id: Number(r.id),
      reviewId: Number(r.review_id),
      itemType: r.item_type,
      rule: r.rule,
      sourceQuote: r.source_quote,
      confidence: r.confidence == null ? null : Number(r.confidence),
      applied: r.applied ?? [],
      actor: r.actor,
      createdAt: new Date(r.created_at).toISOString(),
      undoneAt: r.undone_at ? new Date(r.undone_at).toISOString() : null,
      undoneBy: r.undone_by,
      item: await listReviewById(pool, Number(r.review_id)),
    });
  }
  return out;
}

/** Reverses one auto-apply: replays its undo steps, marks it undone and its review item rejected. */
export async function undoAutoApply(pool: pg.Pool, id: number, by: string): Promise<{ undone: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`select * from auto_applies where id = $1 for update`, [id]);
    const a = rows[0];
    if (!a) throw new UndoError(404, "auto-applied change not found");
    if (a.undone_at) throw new UndoError(409, "already undone");
    const undone = await runUndo(client, (a.undo ?? []) as UndoOp[]);
    await client.query(`update auto_applies set undone_at = now(), undone_by = $2 where id = $1`, [id, by]);
    await client.query(`update review_queue set status = 'rejected', decided_at = now(), decided_by = 'undo' where id = $1`, [a.review_id]);
    await client.query("commit");
    return { undone };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
