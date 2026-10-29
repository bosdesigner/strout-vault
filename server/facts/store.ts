// Writing extracted facts: one open fact per real promise, however many times it is repeated.
//
// The extractor hands over each fact it keeps with the moment it came from. storeFact either adds
// that moment to a fact already on record (fact_sources) or writes a new open fact. "Already on
// record" is decided in this order:
//   1. the model said so: same_as_fact_id names one of the open facts it was shown for these people;
//   2. the same normalized text in the same workspace (dedupe_key), open;
//   3. close wording (content-word overlap) for the same owner, in the same kind group
//      (commitment / task / followup count as one group), open, said within EXTRACT_DEDUPE_DAYS.
// Candidates are open facts in the same workspace, or about / owed by the same person wherever they
// were filed: the email is often in inbox when the call that repeats it is filed.
// A merged fact keeps its first text and gains the later due date only when it had none.
import type pg from "pg";
import type { OwnerIdentity } from "../messages/identity.ts";

/** Kinds that are something someone still has to do: list_open_commitments returns these. */
export const ACTION_KINDS = ["commitment", "task", "followup"] as const;

export function kindGroup(kind: string): string {
  return (ACTION_KINDS as readonly string[]).includes(kind) ? "action" : kind;
}

const STOP = new Set(
  "the a an and or to of for on in at by with from that this it is be will would should can could i we you he she they them his her their our my me us ben send get got have has had do does did about over into up out just also then than so as if not no yes".split(" "),
);

export function normalizeFactText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$.]+/g, " ")
    .trim();
}

export function factDedupeKey(kind: string, text: string): string {
  return `${kindGroup(kind)}:${normalizeFactText(text)}`;
}

function contentWords(s: string): Set<string> {
  return new Set(
    normalizeFactText(s)
      .split(" ")
      .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard overlap of content words: 1 for the same sentence, about 0.6+ for the same promise reworded. */
export function textSimilarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export interface ExtractedFact {
  interactionId: number;
  workspaceId: string;
  kind: string;
  text: string;
  ownerPartyId?: number | null;
  aboutPartyId?: number | null;
  projectId?: number | null;
  amount?: number | null;
  dueDate?: string | null;
  dueText?: string | null;
  quote?: string | null;
  quoteStartSec?: number | null;
  messageIndex?: number | null;
  confidence: number;
  /** The model's "this is the same as open fact #n". Only ids it was shown are passed through. */
  sameAsFactId?: number | null;
  model?: string;
}

export interface StoreOutcome {
  factId: number;
  merged: boolean;
  how?: "model" | "key" | "similar";
}

interface OpenFactRow {
  id: number;
  kind: string;
  text: string;
  owner_party_id: number | null;
  dedupe_key: string | null;
}

/** Same-owner rewording needs this much overlap; with an owner missing on either side, more. */
const SIMILAR_SAME_OWNER = 0.6;
const SIMILAR_UNKNOWN_OWNER = 0.75;

export function findDuplicate(f: Pick<ExtractedFact, "kind" | "text" | "ownerPartyId">, open: OpenFactRow[]): { id: number; how: "key" | "similar" } | null {
  const key = factDedupeKey(f.kind, f.text);
  const exact = open.find((o) => (o.dedupe_key ?? factDedupeKey(o.kind, o.text)) === key);
  if (exact) return { id: Number(exact.id), how: "key" };
  let best: { id: number; score: number } | null = null;
  for (const o of open) {
    if (kindGroup(o.kind) !== kindGroup(f.kind)) continue;
    const owners = f.ownerPartyId != null && o.owner_party_id != null;
    if (owners && Number(o.owner_party_id) !== Number(f.ownerPartyId)) continue;
    const score = textSimilarity(f.text, o.text);
    if (score >= (owners ? SIMILAR_SAME_OWNER : SIMILAR_UNKNOWN_OWNER) && (!best || score > best.score)) best = { id: Number(o.id), score };
  }
  return best ? { id: best.id, how: "similar" } : null;
}

async function addSource(db: pg.PoolClient | pg.Pool, factId: number, f: ExtractedFact): Promise<void> {
  await db.query(
    `insert into fact_sources (fact_id, interaction_id, quote, quote_start_sec, message_index) values ($1, $2, $3, $4, $5)
     on conflict (fact_id, interaction_id, coalesce(quote_start_sec, -1)) do nothing`,
    [factId, f.interactionId, f.quote ?? null, f.quoteStartSec ?? null, f.messageIndex ?? null],
  );
}

export async function storeFact(db: pg.PoolClient | pg.Pool, f: ExtractedFact, opts: { dedupeDays: number }): Promise<StoreOutcome> {
  let target: { id: number; how: StoreOutcome["how"] } | null = null;
  if (f.sameAsFactId) {
    const { rows } = await db.query(`select id from facts where id = $1 and coalesce(status, 'open') = 'open'`, [f.sameAsFactId]);
    if (rows[0]) target = { id: Number(rows[0].id), how: "model" };
  }
  if (!target) {
    const { rows } = await db.query<OpenFactRow>(
      `select id, kind, text, owner_party_id, dedupe_key from facts
        where coalesce(status, 'open') = 'open'
          -- The same workspace, or the same people wherever it was filed (an inbox email, then a filed call).
          and (workspace_id is not distinct from $1 or ($3::bigint is not null and owner_party_id = $3) or ($4::bigint is not null and about_party_id = $4))
          and created_at >= now() - make_interval(days => $2)
        order by created_at desc limit 300`,
      [f.workspaceId, opts.dedupeDays, f.ownerPartyId ?? null, f.aboutPartyId ?? null],
    );
    target = findDuplicate(f, rows);
  }
  if (target) {
    await addSource(db, target.id, f);
    await db.query(
      `update facts set due_date = coalesce(due_date, $2::date), due_text = coalesce(due_text, $3), owner_party_id = coalesce(owner_party_id, $4),
              confidence = greatest(coalesce(confidence, 0), $5),
              -- A fact first heard in an unfiled inbox thread moves to the workspace of the filed conversation.
              workspace_id = case when workspace_id = 'inbox' and $6::text <> 'inbox' then $6 else workspace_id end,
              updated_at = now() where id = $1`,
      [target.id, f.dueDate ?? null, f.dueText ?? null, f.ownerPartyId ?? null, f.confidence, f.workspaceId],
    );
    return { factId: target.id, merged: true, how: target.how };
  }
  const { rows } = await db.query<{ id: number }>(
    `insert into facts (interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, project_id, amount, due_date, status, confidence,
                        quote_start_sec, quote, message_index, due_text, origin, dedupe_key, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12, $13, $14, 'extract', $15, now()) returning id`,
    [
      f.interactionId,
      f.workspaceId,
      f.kind,
      f.text,
      f.ownerPartyId ?? null,
      f.aboutPartyId ?? null,
      f.projectId ?? null,
      f.amount ?? null,
      f.dueDate ?? null,
      f.confidence,
      f.quoteStartSec ?? null,
      f.quote ?? null,
      f.messageIndex ?? null,
      f.dueText ?? null,
      factDedupeKey(f.kind, f.text),
    ],
  );
  const id = Number(rows[0].id);
  await addSource(db, id, f);
  return { factId: id, merged: false };
}

/**
 * Ben as a party, so "who owes it" can say Ben. Found by the vault_owner marker or one of his
 * emails; created once (with his emails) when neither exists. Routing and the participant resolver
 * still never treat him as "the other participant": they recognise his identifiers first.
 */
export async function ensureOwnerParty(db: pg.PoolClient | pg.Pool, owner: OwnerIdentity, fullName: string): Promise<{ id: number; name: string }> {
  const emails = [...owner.emails];
  const { rows } = await db.query(
    `select id, name from parties where kind = 'person' and (external_refs->>'vault_owner' = 'true' or (cardinality($1::text[]) > 0 and emails && $1::text[]))
      order by (external_refs->>'vault_owner' = 'true') desc nulls last, id limit 1`,
    [emails],
  );
  if (rows[0]) return { id: Number(rows[0].id), name: rows[0].name };
  const ins = await db.query(`insert into parties (kind, name, emails, phones, external_refs) values ('person', $1, $2::text[], $3::text[], '{"vault_owner": "true"}'::jsonb) returning id, name`, [
    fullName,
    emails,
    [...owner.phones],
  ]);
  return { id: Number(ins.rows[0].id), name: ins.rows[0].name };
}

/** Closes or reopens a fact by hand (the Done button, the facts endpoint). */
export async function setFactStatus(db: pg.Pool, factId: number, status: "open" | "done" | "dropped"): Promise<{ id: number; status: string; closedAt: string | null } | null> {
  const { rows } = await db.query(
    `update facts set status = $2,
            closed_at = case when $2 = 'open' then null else coalesce(closed_at, now()) end,
            closed_by_interaction_id = case when $2 = 'open' then null else closed_by_interaction_id end,
            updated_at = now()
      where id = $1 returning id, status, closed_at`,
    [factId, status],
  );
  return rows[0] ? { id: Number(rows[0].id), status: rows[0].status, closedAt: rows[0].closed_at ? new Date(rows[0].closed_at).toISOString() : null } : null;
}

let factSourcesKnown = false;
/** fact_sources arrives with 0013; until it is applied, pages read facts as before. Cached once true. */
export async function hasFactSources(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  if (factSourcesKnown) return true;
  const { rows } = await db.query(`select to_regclass('fact_sources') is not null as ok`);
  factSourcesKnown = rows[0]?.ok === true;
  return factSourcesKnown;
}
