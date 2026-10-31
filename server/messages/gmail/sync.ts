// Gmail into the vault, read-only. Two modes per connected account (message_accounts):
//
//   backfill     messages.list "after:<since>" page by page, each new thread fetched with
//                threads.get and ingested. Resumable: the page token lives in worker_state
//                (gmail_backfill:<account id>), so a stopped run picks up where it was. Run by
//                hand: `npm run messages:gmail -- --account you@x.com --since 30 [--dry-run]`.
//   incremental  history.list from the stored historyId (every 10 minutes from the worker). When
//                Google has expired that historyId (404), falls back to messages.list since the
//                last successful run and takes a fresh historyId from the profile.
//
// Every thread goes through server/messages/ingest.ts (filter, redact, match, route, write).
// One import_runs row per run carries the skip counts per reason. Gmail costs quota units, not
// money, so nothing is written to spend_ledger.
import type pg from "pg";
import type { Config } from "../../config.ts";
import { decryptSecret } from "../crypto.ts";
import { emptyIngestSummary, ingestThreads, mergeIngestSummary, recordImportRun, type IngestSummary } from "../ingest.ts";
import { ownerIdentity } from "../identity.ts";
import { loadMessageRules, type MessageRules } from "../rules.ts";
import { GmailApiError, GmailClient } from "./api.ts";
import { gmailThreadInput } from "./parse.ts";
import { tryAdvisoryLock } from "../../db/locks.ts";

export interface GmailAccount {
  id: number;
  accountEmail: string;
  refreshTokenEnc: string;
  historyId: string | null;
  status: string;
  lastSyncedAt: Date | null;
}

export interface GmailDeps {
  pool: pg.Pool;
  config: Config;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  /** Epoch ms after which no new thread is fetched. */
  deadline?: number;
  /** Tests inject rules instead of reading config/*.yml. */
  rules?: MessageRules;
}

export interface GmailAccountResult {
  account: string;
  mode: "initialized" | "history" | "fallback" | "backfill";
  threads: number;
  apiCalls: number;
  done?: boolean;
  error?: string;
}

export interface GmailSyncSummary {
  configured: boolean;
  dryRun: boolean;
  accounts: GmailAccountResult[];
  ingest: IngestSummary;
  stoppedEarly?: string;
  skipped?: string;
  errors: string[];
}

const THREAD_CONCURRENCY = 4;
const INGEST_CHUNK = 25;

export function gmailConfigured(config: Config): boolean {
  return !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.MESSAGES_ENCRYPTION_KEY);
}

export async function listGmailAccounts(pool: pg.Pool, opts: { activeOnly?: boolean; email?: string } = {}): Promise<GmailAccount[]> {
  const conds = [`provider = 'gmail'`];
  const params: unknown[] = [];
  if (opts.activeOnly) conds.push(`status = 'active'`);
  if (opts.email) {
    params.push(opts.email.toLowerCase());
    conds.push(`account_email = $${params.length}`);
  }
  const { rows } = await pool.query(`select * from message_accounts where ${conds.join(" and ")} order by id`, params);
  return rows.map((r) => ({
    id: Number(r.id),
    accountEmail: r.account_email,
    refreshTokenEnc: r.refresh_token_enc,
    historyId: r.history_id,
    status: r.status,
    lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at) : null,
  }));
}

export function clientFor(deps: GmailDeps, account: GmailAccount): GmailClient {
  const c = deps.config;
  return new GmailClient({
    apiBase: c.GMAIL_API_BASE,
    tokenUrl: c.GOOGLE_OAUTH_TOKEN_URL,
    clientId: c.GOOGLE_CLIENT_ID!,
    clientSecret: c.GOOGLE_CLIENT_SECRET!,
    refreshToken: decryptSecret(account.refreshTokenEnc, c.MESSAGES_ENCRYPTION_KEY),
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    log: deps.log,
  });
}

function outOfTime(deps: GmailDeps): boolean {
  return deps.deadline !== undefined && deps.now().getTime() >= deps.deadline;
}

/** Fetches threads (a few at a time) and ingests them in chunks. Returns how many were fetched. */
async function fetchAndIngest(deps: GmailDeps, client: GmailClient, account: GmailAccount, threadIds: string[], dryRun: boolean, into: IngestSummary): Promise<{ fetched: number; complete: boolean }> {
  const rules = deps.rules ?? loadMessageRules(deps.config.MESSAGES_CONFIG_DIR);
  const owner = ownerIdentity(deps.config, [account.accountEmail]);
  let fetched = 0;
  for (let i = 0; i < threadIds.length; i += INGEST_CHUNK) {
    if (outOfTime(deps)) return { fetched, complete: false };
    const chunk = threadIds.slice(i, i + INGEST_CHUNK);
    const threads = [];
    for (let j = 0; j < chunk.length; j += THREAD_CONCURRENCY) {
      const got = await Promise.all(
        chunk.slice(j, j + THREAD_CONCURRENCY).map((id) =>
          client.thread(id).catch((err: Error) => {
            // A thread deleted between list and get is gone; nothing to store.
            if (err instanceof GmailApiError && err.status === 404) return null;
            throw err;
          }),
        ),
      );
      for (const t of got) if (t) threads.push(gmailThreadInput(account.accountEmail, t));
    }
    fetched += threads.length;
    const s = await ingestThreads(deps.pool, threads, { owner, rules, dryRun, record: false });
    mergeIngestSummary(into, s);
  }
  return { fetched, complete: true };
}

const BASE_QUERY = "-in:chats -in:spam -in:trash -in:drafts";

async function getState<T>(pool: pg.Pool, key: string): Promise<T | null> {
  const { rows } = await pool.query(`select value from worker_state where key = $1`, [key]);
  return (rows[0]?.value as T) ?? null;
}
async function setState(pool: pg.Pool, key: string, value: unknown): Promise<void> {
  await pool.query(`insert into worker_state (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

interface BackfillState {
  since_days: number;
  after: number;
  page_token: string | null;
  pages: number;
  threads: number;
  start_history_id: string | null;
  done: boolean;
}

/** One backfill pass for one account, resumable. With dryRun nothing (not even the cursor) is written. */
export async function backfillGmail(deps: GmailDeps, account: GmailAccount, opts: { sinceDays: number; dryRun?: boolean; restart?: boolean; maxThreads?: number }, into: IngestSummary): Promise<GmailAccountResult> {
  const client = clientFor(deps, account);
  const key = `gmail_backfill:${account.id}`;
  let state = opts.dryRun || opts.restart ? null : await getState<BackfillState>(deps.pool, key);
  if (state && (state.since_days !== opts.sinceDays || state.done)) {
    if (state.done && state.since_days >= opts.sinceDays) return { account: account.accountEmail, mode: "backfill", threads: 0, apiCalls: 0, done: true };
    state = null;
  }
  if (!state) {
    const profile = await client.profile();
    state = { since_days: opts.sinceDays, after: Math.floor(deps.now().getTime() / 1000) - opts.sinceDays * 86400, page_token: null, pages: 0, threads: 0, start_history_id: profile.historyId, done: false };
  }
  const seen = new Set<string>();
  let threads = 0;
  while (!state.done) {
    if (outOfTime(deps) || (opts.maxThreads && threads >= opts.maxThreads)) break;
    const page = await client.listMessages(`after:${state.after} ${BASE_QUERY}`, state.page_token ?? undefined);
    const ids = [...new Set((page.messages ?? []).map((m) => m.threadId))].filter((id) => !seen.has(id));
    const take = opts.maxThreads ? ids.slice(0, Math.max(0, opts.maxThreads - threads)) : ids;
    take.forEach((id) => seen.add(id));
    const r = await fetchAndIngest(deps, client, account, take, !!opts.dryRun, into);
    threads += r.fetched;
    if (!r.complete || take.length < ids.length) break; // resume this page next time
    state.page_token = page.nextPageToken ?? null;
    state.pages++;
    state.threads += r.fetched;
    if (!state.page_token) state.done = true;
    deps.log(`gmail: ${account.accountEmail}: page ${state.pages}, ${threads} thread(s) read so far (${into.created} ${opts.dryRun ? "would be new" : "new"}, ${into.unchanged} unchanged)${state.done ? ", last page" : ""}`);
    if (!opts.dryRun) await setState(deps.pool, key, state);
  }
  if (!opts.dryRun && state.done && !account.historyId && state.start_history_id) {
    // The incremental sync starts where the backfill began, so nothing between the two is missed.
    await deps.pool.query(`update message_accounts set history_id = $2, updated_at = now() where id = $1 and history_id is null`, [account.id, state.start_history_id]);
  }
  return { account: account.accountEmail, mode: "backfill", threads, apiCalls: client.calls, done: state.done };
}

/** One incremental pass for one account. */
export async function syncGmailAccount(deps: GmailDeps, account: GmailAccount, opts: { dryRun?: boolean }, into: IngestSummary): Promise<GmailAccountResult> {
  const client = clientFor(deps, account);
  if (!account.historyId) {
    // Never synced: start from now. History before this point is the backfill's job.
    const profile = await client.profile();
    if (!opts.dryRun) await deps.pool.query(`update message_accounts set history_id = $2, last_synced_at = now(), last_error = null, updated_at = now() where id = $1`, [account.id, profile.historyId]);
    return { account: account.accountEmail, mode: "initialized", threads: 0, apiCalls: client.calls };
  }
  const threadIds = new Set<string>();
  let newHistoryId: string | null = null;
  let mode: GmailAccountResult["mode"] = "history";
  try {
    let pageToken: string | undefined;
    do {
      const page = await client.history(account.historyId, pageToken);
      for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) threadIds.add(a.message.threadId);
      newHistoryId = page.historyId ?? newHistoryId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (!(err instanceof GmailApiError && err.status === 404)) throw err;
    // historyId too old: Google keeps roughly a week. List everything since the last good run.
    mode = "fallback";
    const since = Math.floor(((account.lastSyncedAt ?? new Date(deps.now().getTime() - 86400_000)).getTime() - 3600_000) / 1000);
    let pageToken: string | undefined;
    do {
      const page = await client.listMessages(`after:${since} ${BASE_QUERY}`, pageToken);
      for (const m of page.messages ?? []) threadIds.add(m.threadId);
      pageToken = page.nextPageToken;
    } while (pageToken);
    newHistoryId = (await client.profile()).historyId;
  }
  const r = await fetchAndIngest(deps, client, account, [...threadIds], !!opts.dryRun, into);
  // Advance only after every thread was handled; an interrupted run repeats (harmlessly) next time.
  if (!opts.dryRun && r.complete) {
    await deps.pool.query(`update message_accounts set history_id = coalesce($2, history_id), last_synced_at = now(), last_error = null, status = 'active', updated_at = now() where id = $1`, [account.id, newHistoryId]);
  }
  return { account: account.accountEmail, mode, threads: r.fetched, apiCalls: client.calls, done: r.complete };
}

const LOCK_NAME = "strout-vault-gmail";

/** The worker's gmail step: an incremental pass over every active account, one at a time across machines. */
export async function syncGmail(deps: GmailDeps, opts: { dryRun?: boolean; email?: string } = {}): Promise<GmailSyncSummary> {
  const summary: GmailSyncSummary = { configured: gmailConfigured(deps.config), dryRun: !!opts.dryRun, accounts: [], ingest: emptyIngestSummary(!!opts.dryRun), errors: [] };
  if (!summary.configured) {
    summary.skipped = "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MESSAGES_ENCRYPTION_KEY are not all set";
    return summary;
  }
  const accounts = await listGmailAccounts(deps.pool, { activeOnly: true, email: opts.email });
  if (!accounts.length) {
    summary.skipped = "no Gmail account connected";
    return summary;
  }
  const lock = await tryAdvisoryLock(deps.pool, LOCK_NAME);
  try {
    if (!lock) {
      summary.skipped = "another Gmail sync is running";
      return summary;
    }
    for (const account of accounts) {
      if (outOfTime(deps)) {
        summary.stoppedEarly = "time budget";
        break;
      }
      try {
        const r = await syncGmailAccount(deps, account, opts, summary.ingest);
        summary.accounts.push(r);
        deps.log(`gmail: ${account.accountEmail}: ${r.mode}, ${r.threads} thread(s), ${r.apiCalls} API call(s)`);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        summary.accounts.push({ account: account.accountEmail, mode: "history", threads: 0, apiCalls: 0, error: msg });
        summary.errors.push(`${account.accountEmail}: ${msg}`);
        deps.log(`gmail: ${account.accountEmail}: FAILED ${msg}`);
        if (!opts.dryRun) {
          const revoked = /invalid_grant/.test(msg);
          await deps.pool.query(`update message_accounts set last_error = $2, status = case when $3 then 'error' else status end, updated_at = now() where id = $1`, [account.id, msg, revoked]);
        }
      }
    }
    if (!opts.dryRun) await recordImportRun(deps.pool, "gmail", summary.ingest, { mode: "incremental", accounts: summary.accounts });
    return summary;
  } finally {
    await lock?.release();
  }
}
