// Instagram DMs into the vault through the official Instagram API (Instagram Login), read-only.
// One pass per connected professional account (message_accounts provider 'instagram'):
//
//   1. refresh the long-lived token when it has under 10 days left (and is at least a day old);
//   2. list conversations newest-first until one was last updated no later than the newest the
//      previous pass read (detail.last_updated); a backfill reads every page;
//   3. read each changed conversation's newest messages (the API's limit is 20) and turn them into
//      the same batch the TikTok collector sends (server/messages/social.ts);
//   4. hand the threads to server/messages/ingest.ts (filter, redact, match by handle, route, write).
//
// The cursor moves only after every changed conversation was read, so an interrupted pass repeats
// (harmlessly: the ingest is idempotent) next time. One import_runs row per pass, source instagram.
// Reading through the API never marks anything read in the Instagram app.
import type pg from "pg";
import type { Config } from "../../config.ts";
import { decryptSecret, encryptSecret } from "../crypto.ts";
import { emptyIngestSummary, ingestThreads, mergeIngestSummary, recordImportRun, type IngestSummary } from "../ingest.ts";
import { ownerIdentity } from "../identity.ts";
import { loadMessageRules, type MessageRules } from "../rules.ts";
import { socialThreads, type SocialBatch, type SocialConversation } from "../social.ts";
import { InstagramApiError, InstagramClient, type IgMessage } from "./api.ts";

export interface InstagramAccount {
  id: number;
  username: string;
  tokenEnc: string;
  tokenExpiresAt: Date | null;
  status: string;
  lastSyncedAt: Date | null;
  detail: InstagramDetail;
}

export interface InstagramDetail {
  /** The professional account's id (messages from Ben carry it). */
  ig_user_id?: string;
  /** The app-scoped id /me also returns. */
  app_user_id?: string;
  /** Epoch ms: the newest conversation updated_time the last complete pass read. */
  last_updated?: number;
  token_refreshed_at?: string;
  conversations_seen?: number;
}

export interface InstagramDeps {
  pool: pg.Pool;
  config: Config;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  deadline?: number;
  rules?: MessageRules;
}

export interface InstagramAccountResult {
  account: string;
  mode: "incremental" | "backfill";
  conversations: number;
  messages: number;
  apiCalls: number;
  tokenRefreshed?: boolean;
  done?: boolean;
  error?: string;
}

export interface InstagramSyncSummary {
  configured: boolean;
  dryRun: boolean;
  accounts: InstagramAccountResult[];
  ingest: IngestSummary;
  stoppedEarly?: string;
  skipped?: string;
  errors: string[];
}

const DAY = 86_400_000;
const REFRESH_WHEN_LEFT_MS = 10 * DAY;
const MAX_CONVERSATIONS = 500;
const LOCK_NAME = "strout-vault-instagram";

export function instagramConfigured(config: Config): boolean {
  return !!(config.INSTAGRAM_APP_ID && config.INSTAGRAM_APP_SECRET && config.MESSAGES_ENCRYPTION_KEY);
}

export async function listInstagramAccounts(pool: pg.Pool, opts: { activeOnly?: boolean; username?: string } = {}): Promise<InstagramAccount[]> {
  const conds = [`provider = 'instagram'`];
  const params: unknown[] = [];
  if (opts.activeOnly) conds.push(`status = 'active'`);
  if (opts.username) {
    params.push(opts.username.replace(/^@/, "").toLowerCase());
    conds.push(`account_email = $${params.length}`);
  }
  const { rows } = await pool.query(`select * from message_accounts where ${conds.join(" and ")} order by id`, params);
  return rows.map((r) => ({
    id: Number(r.id),
    username: r.account_email,
    tokenEnc: r.refresh_token_enc,
    tokenExpiresAt: r.token_expires_at ? new Date(r.token_expires_at) : null,
    status: r.status,
    lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at) : null,
    detail: (r.detail ?? {}) as InstagramDetail,
  }));
}

function outOfTime(deps: InstagramDeps): boolean {
  return deps.deadline !== undefined && deps.now().getTime() >= deps.deadline;
}

export function clientFor(deps: InstagramDeps, accessToken: string): InstagramClient {
  return new InstagramClient({ graphBase: deps.config.INSTAGRAM_GRAPH_BASE, version: deps.config.INSTAGRAM_API_VERSION, accessToken, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now });
}

/** updated_time / created_time arrive as ISO ("2026-10-27T14:05:00+0000") or Unix seconds. */
export function igTime(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === "") return NaN;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(String(v).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
}

/** One API conversation as the batch the ingest takes, or null when there is no other person in it. */
export function igConversation(conversationId: string, messages: IgMessage[], me: { ids: Set<string>; username: string }): SocialConversation | null {
  const isMe = (u?: { id?: string; username?: string }) => !!u && ((u.id !== undefined && me.ids.has(String(u.id))) || (!!u.username && u.username.toLowerCase() === me.username));
  let peer: { id?: string; username?: string } | undefined;
  for (const m of messages) {
    if (m.from && !isMe(m.from)) peer ??= m.from;
    for (const t of m.to?.data ?? []) if (!isMe(t)) peer ??= t;
  }
  if (!peer?.username) return null;
  const out: SocialConversation = {
    conversation_id: conversationId,
    peer: { username: peer.username.toLowerCase(), display_name: null, platform_id: peer.id ? String(peer.id) : null },
    messages: [],
  };
  for (const m of messages) {
    const at = igTime(m.created_time);
    if (!Number.isFinite(at)) continue;
    const share = m.shares?.data?.find((s) => s.link)?.link ?? null;
    const atts = (m.attachments?.data ?? []).map((a) => ({
      filename: a.name ?? (a.image_data ? "image" : a.video_data ? "video" : null),
      mime: a.mime_type ?? (a.image_data ? "image/*" : a.video_data ? "video/*" : null),
      size: typeof a.size === "number" ? a.size : null,
    }));
    out.messages.push({
      id: m.id,
      sent_at: new Date(at).toISOString(),
      from_me: isMe(m.from),
      text: m.message ?? (m.is_unsupported ? "[a message type the Instagram API does not show]" : ""),
      attachments: atts,
      shared_url: share && /^https?:\/\//.test(share) ? share : null,
    });
  }
  return out;
}

async function saveToken(pool: pg.Pool, account: InstagramAccount, token: { accessToken: string; expiresAt: Date }, key: string, now: Date): Promise<void> {
  await pool.query(
    `update message_accounts set refresh_token_enc = $2, token_expires_at = $3, detail = coalesce(detail, '{}'::jsonb) || $4::jsonb, updated_at = now() where id = $1`,
    [account.id, encryptSecret(token.accessToken, key), token.expiresAt, JSON.stringify({ token_refreshed_at: now.toISOString() })],
  );
}

/** One pass for one account. With dryRun nothing (not even the cursor or a refreshed token) is written. */
export async function syncInstagramAccount(deps: InstagramDeps, account: InstagramAccount, opts: { dryRun?: boolean; backfill?: boolean }, into: IngestSummary): Promise<InstagramAccountResult> {
  const now = deps.now();
  let token = decryptSecret(account.tokenEnc, deps.config.MESSAGES_ENCRYPTION_KEY!);
  let client = clientFor(deps, token);
  let tokenRefreshed = false;
  const refreshedAt = account.detail.token_refreshed_at ? Date.parse(account.detail.token_refreshed_at) : 0;
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() - now.getTime() < REFRESH_WHEN_LEFT_MS && now.getTime() - refreshedAt > DAY && !opts.dryRun) {
    const fresh = await client.refresh();
    await saveToken(deps.pool, account, fresh, deps.config.MESSAGES_ENCRYPTION_KEY!, now);
    token = fresh.accessToken;
    const calls = client.calls;
    client = clientFor(deps, token);
    client.calls = calls;
    tokenRefreshed = true;
    deps.log(`instagram: @${account.username}: token refreshed, good until ${fresh.expiresAt.toISOString().slice(0, 10)}`);
  }

  const me = { ids: new Set([account.detail.ig_user_id, account.detail.app_user_id].filter((x): x is string => !!x)), username: account.username };
  if (!me.ids.size) {
    const who = await client.me();
    me.ids = new Set([who.userId, who.id].filter(Boolean));
  }
  // A conversation that changed since the last pass has a later updated_time than the newest one it read.
  const since = opts.backfill ? 0 : (account.detail.last_updated ?? 0);

  // Changed conversations, newest first; stop at the first one older than the last pass.
  const changed: Array<{ id: string; updated: number }> = [];
  let after: string | undefined;
  let newest = account.detail.last_updated ?? 0;
  pages: do {
    const page = await client.conversations(after);
    for (const c of page.items) {
      const updated = igTime(c.updated_time);
      if (Number.isFinite(updated) && updated <= since) break pages;
      changed.push({ id: c.id, updated: Number.isFinite(updated) ? updated : now.getTime() });
      if (changed.length >= MAX_CONVERSATIONS) break pages;
    }
    after = page.after ?? undefined;
  } while (after);

  const rules = deps.rules ?? loadMessageRules(deps.config.MESSAGES_CONFIG_DIR);
  const owner = ownerIdentity(deps.config, [], [`instagram:${account.username}`]);
  const batch: SocialBatch = { platform: "instagram", account: account.username, conversations: [] };
  let complete = true;
  let messages = 0;
  for (const c of changed) {
    if (outOfTime(deps)) {
      complete = false;
      break;
    }
    const conv = igConversation(c.id, await client.messages(c.id), me);
    if (conv) {
      batch.conversations.push(conv);
      messages += conv.messages.length;
    }
    newest = Math.max(newest, c.updated);
    if (batch.conversations.length >= 25) {
      mergeIngestSummary(into, await ingestThreads(deps.pool, socialThreads(batch), { owner, rules, dryRun: !!opts.dryRun, record: false }));
      batch.conversations = [];
    }
  }
  if (batch.conversations.length) mergeIngestSummary(into, await ingestThreads(deps.pool, socialThreads(batch), { owner, rules, dryRun: !!opts.dryRun, record: false }));

  if (!opts.dryRun && complete) {
    await deps.pool.query(
      `update message_accounts set last_synced_at = now(), last_error = null, status = 'active', updated_at = now(), detail = coalesce(detail, '{}'::jsonb) || $2::jsonb where id = $1`,
      [account.id, JSON.stringify({ last_updated: newest, conversations_seen: changed.length, ig_user_id: account.detail.ig_user_id ?? [...me.ids][0] ?? null })],
    );
  }
  return { account: account.username, mode: opts.backfill ? "backfill" : "incremental", conversations: changed.length, messages, apiCalls: client.calls, tokenRefreshed, done: complete };
}

/** The worker's instagram step (and `npm run messages:instagram`): one pass over every active account. */
export async function syncInstagram(deps: InstagramDeps, opts: { dryRun?: boolean; username?: string; backfill?: boolean } = {}): Promise<InstagramSyncSummary> {
  const summary: InstagramSyncSummary = { configured: instagramConfigured(deps.config), dryRun: !!opts.dryRun, accounts: [], ingest: emptyIngestSummary(!!opts.dryRun), errors: [] };
  if (!summary.configured) {
    summary.skipped = "INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and MESSAGES_ENCRYPTION_KEY are not all set";
    return summary;
  }
  const accounts = await listInstagramAccounts(deps.pool, { activeOnly: true, username: opts.username });
  if (!accounts.length) {
    summary.skipped = "no Instagram account connected";
    return summary;
  }
  const lock = await deps.pool.connect();
  let locked = false;
  try {
    locked = !!(await lock.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LOCK_NAME])).rows[0]?.ok;
    if (!locked) {
      summary.skipped = "another Instagram sync is running";
      return summary;
    }
    for (const account of accounts) {
      if (outOfTime(deps)) {
        summary.stoppedEarly = "time budget";
        break;
      }
      try {
        const r = await syncInstagramAccount(deps, account, opts, summary.ingest);
        summary.accounts.push(r);
        if (!r.done) summary.stoppedEarly = "time budget";
        deps.log(`instagram: @${account.username}: ${r.mode}, ${r.conversations} conversation(s), ${r.messages} message(s), ${r.apiCalls} API call(s)`);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        summary.accounts.push({ account: account.username, mode: opts.backfill ? "backfill" : "incremental", conversations: 0, messages: 0, apiCalls: 0, error: msg });
        summary.errors.push(`@${account.username}: ${msg}`);
        deps.log(`instagram: @${account.username}: FAILED ${msg}`);
        if (!opts.dryRun) {
          const dead = err instanceof InstagramApiError && err.tokenInvalid;
          await deps.pool.query(`update message_accounts set last_error = $2, status = case when $3 then 'error' else status end, updated_at = now() where id = $1`, [account.id, msg, dead]);
        }
      }
    }
    if (!opts.dryRun) await recordImportRun(deps.pool, "instagram", summary.ingest, { mode: opts.backfill ? "backfill" : "incremental", accounts: summary.accounts });
    return summary;
  } finally {
    if (locked) await lock.query(`select pg_advisory_unlock(hashtext($1))`, [LOCK_NAME]).catch(() => {});
    lock.release();
  }
}
