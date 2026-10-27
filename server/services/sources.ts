// The Sources panel (Pipeline page, owner only): one row per ingest point with its health, read
// from the tables each ingest point writes, never from configuration alone:
//
//   Zoom                  worker_runs (summary.zoom, summary.config) + interactions source zoom
//   Gmail, per account    message_accounts (provider gmail) + interactions source_ref gmail:<account>:…
//   iMessage              api_tokens (ingest:messages) + import_runs source imessage
//   Mac media collector   api_tokens (purpose mac_media) + import_runs source apple_media, one row per
//                         source (voice memos, call recordings, notes) + interactions via mac_collector
//   iPhone Shortcut       api_tokens (purpose ios_shortcut) + import_runs source ios_shortcut
//   Google Meet, per acct message_accounts (provider meet) + interactions source_ref meet:<account>:…
//   Twilio calls          tracked_numbers + calls + interactions source contractor_call
//
// Status: live | never_run (configured but nothing has run) | not_configured | erroring. A
// collector that has not checked in for an hour, or a worker source not synced for two, carries a
// warning. Errors are truncated and carry no content (they are API and status messages).
import type pg from "pg";
import type { Config } from "../config.ts";

export type SourceStatus = "live" | "never_run" | "not_configured" | "erroring";

export interface SourceRow {
  id: string;
  label: string;
  /** The account or sub-source, when a source has several rows. */
  detail: string | null;
  status: SourceStatus;
  warning: string | null;
  lastSuccessAt: string | null;
  /** Last time it was heard from at all (a run, a batch, a sync), successful or not. */
  lastSeenAt: string | null;
  items24h: number;
  items7d: number;
  total: number;
  lastError: string | null;
  note: string | null;
}

export interface SourcesReport {
  generatedAt: string;
  rows: SourceRow[];
}

const HOUR = 3600_000;
const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const ago = (d: string | null, now: Date) => (d ? now.getTime() - new Date(d).getTime() : Infinity);
const short = (s: unknown): string | null => (s ? String(s).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://…").replace(/\s+/g, " ").trim().slice(0, 200) : null);

function fmtAge(ms: number): string {
  const h = Math.floor(ms / HOUR);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

interface Counts {
  total: number;
  d1: number;
  d7: number;
  last: string | null;
}

async function itemCounts(pool: pg.Pool, where: string, params: unknown[]): Promise<Counts> {
  const { rows } = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where created_at > now() - interval '1 day')::int as d1,
            count(*) filter (where created_at > now() - interval '7 days')::int as d7,
            max(created_at) as last
       from interactions where ${where}`,
    params,
  );
  return { total: rows[0].total, d1: rows[0].d1, d7: rows[0].d7, last: iso(rows[0].last) };
}

function row(base: Omit<SourceRow, "items24h" | "items7d" | "total">, c: Counts): SourceRow {
  return { ...base, items24h: c.d1, items7d: c.d7, total: c.total };
}

export async function buildSources(pool: pg.Pool, config: Config, now = new Date()): Promise<SourcesReport> {
  const rows: SourceRow[] = [];
  rows.push(await zoomRow(pool, now));
  rows.push(...(await accountRows(pool, "gmail", now)));
  rows.push(await imessageRow(pool, now));
  rows.push(...(await macRows(pool, now)));
  rows.push(await shortcutRow(pool));
  rows.push(...(await accountRows(pool, "meet", now)));
  rows.push(await twilioRow(pool, config));
  return { generatedAt: now.toISOString(), rows };
}

// ---- Zoom: the hourly worker's own reports ----------------------------------------------------
async function zoomRow(pool: pg.Pool, now: Date): Promise<SourceRow> {
  const { rows: runs } = await pool.query(
    `select finished_at, started_at, summary->'zoom' as zoom, summary->'config'->>'zoomConfigured' as configured
       from worker_runs where summary ? 'zoom' or summary ? 'config' order by started_at desc limit 100`,
  );
  const withZoom = runs.filter((r) => r.zoom);
  const configured = runs.find((r) => r.configured != null)?.configured === "true" || withZoom.some((r) => r.zoom?.configured);
  const ok = withZoom.find((r) => r.zoom.configured && !(r.zoom.errors ?? []).length);
  const latest = withZoom.find((r) => r.zoom.configured) ?? null;
  const lastSuccessAt = iso(ok?.finished_at ?? ok?.started_at);
  const failing = latest && (latest.zoom.errors ?? []).length && latest !== ok ? latest : null;
  const c = await itemCounts(pool, `source = 'zoom'`, []);
  const status: SourceStatus = !configured ? "not_configured" : !latest ? "never_run" : failing ? "erroring" : "live";
  return row(
    {
      id: "zoom",
      label: "Zoom",
      detail: null,
      status,
      warning: status === "live" && ago(lastSuccessAt, now) > 2 * HOUR ? `no successful sync in ${fmtAge(ago(lastSuccessAt, now))} (the worker runs hourly)` : null,
      lastSuccessAt,
      lastSeenAt: iso(latest?.finished_at ?? latest?.started_at),
      lastError: failing ? short((failing.zoom.errors ?? [])[0]) : null,
      note: configured ? null : "ZOOM_* secrets are not set on the worker",
    },
    c,
  );
}

// ---- Gmail and Google Meet: one row per connected account ---------------------------------------
async function accountRows(pool: pg.Pool, provider: "gmail" | "meet", now: Date): Promise<SourceRow[]> {
  const label = provider === "gmail" ? "Gmail" : "Google Meet";
  const { rows } = await pool.query(`select to_jsonb(a) as a from message_accounts a where provider = $1 order by id`, [provider]).catch(() => ({ rows: [] as Array<{ a: Record<string, unknown> }> }));
  if (!rows.length) {
    const c = await itemCounts(pool, `source = $1`, [provider]);
    return [row({ id: provider, label, detail: null, status: "not_configured", warning: null, lastSuccessAt: null, lastSeenAt: null, lastError: null, note: `no account connected (/api/messages/${provider}/connect)` }, c)];
  }
  const out: SourceRow[] = [];
  for (const { a } of rows) {
    const email = String(a.account_email);
    const c = await itemCounts(pool, `source = $1 and source_ref like $2`, [provider, `${provider}:${email}:%`]);
    const synced = iso(a.last_synced_at);
    const disabled = a.status === "disabled";
    const erroring = a.status === "error" || (!!a.last_error && (!synced || new Date(a.updated_at as string) >= new Date(synced)));
    const status: SourceStatus = disabled ? "not_configured" : erroring ? "erroring" : !synced && !(provider === "gmail" && a.history_id) ? "never_run" : "live";
    const limit = provider === "gmail" ? 0.5 * HOUR : 2 * HOUR;
    const noRecordings = provider === "meet" && a.capability === "none_found";
    out.push(
      row(
        {
          id: `${provider}:${email}`,
          label,
          detail: email,
          status,
          warning: status === "live" && synced && ago(synced, now) > limit ? `not synced in ${fmtAge(ago(synced, now))} (${provider === "gmail" ? "the sync runs every 10 minutes" : "the worker runs hourly"})` : null,
          lastSuccessAt: synced,
          lastSeenAt: iso(a.updated_at) ?? synced,
          lastError: erroring ? short(a.last_error) : null,
          note: disabled ? "disabled" : noRecordings ? "no Meet recordings on this account (its plan may not record)" : provider === "gmail" && !synced && a.history_id ? "history recorded; new mail syncs from here, run the backfill for the past" : null,
        },
        c,
      ),
    );
  }
  return out;
}

// ---- collectors (bearer tokens + import_runs) ----------------------------------------------------
async function liveTokens(pool: pg.Pool, scope: string, purpose?: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from api_tokens t
      where revoked_at is null and (expires_at is null or expires_at > now()) and $1 = any(scopes)
        and ($2::text is null or coalesce(to_jsonb(t)->>'purpose', 'mac_media') = $2)`,
    [scope, purpose ?? null],
  );
  return rows[0].n;
}

async function runsOf(pool: pg.Pool, source: string) {
  const { rows } = await pool.query(
    `select (select to_jsonb(r) from import_runs r where r.source = $1 order by coalesce(r.finished_at, r.started_at) desc limit 1) as latest,
            (select to_jsonb(r) from import_runs r where r.source = $1 and r.ok order by r.finished_at desc limit 1) as ok,
            (select count(*)::int from import_runs r where r.source = $1) as n`,
    [source],
  );
  return rows[0] as { latest: Record<string, unknown> | null; ok: Record<string, unknown> | null; n: number };
}

async function imessageRow(pool: pg.Pool, now: Date): Promise<SourceRow> {
  const [tokens, runs, c] = await Promise.all([liveTokens(pool, "ingest:messages"), runsOf(pool, "imessage"), itemCounts(pool, `source = 'imessage'`, [])]);
  const lastSeenAt = iso(runs.latest?.finished_at ?? runs.latest?.started_at);
  const status: SourceStatus = !tokens && !runs.n ? "not_configured" : !runs.n ? "never_run" : runs.latest?.ok === false ? "erroring" : "live";
  return row(
    {
      id: "imessage",
      label: "iMessage / SMS",
      detail: "Mac collector",
      status,
      warning: status !== "not_configured" && runs.n && ago(lastSeenAt, now) > HOUR ? `no batch in ${fmtAge(ago(lastSeenAt, now))} (it only sends when there are new texts)` : null,
      lastSuccessAt: iso(runs.ok?.finished_at),
      lastSeenAt,
      lastError: status === "erroring" ? `last batch had ${(runs.latest?.counts_out as Record<string, unknown> | undefined)?.errors ?? "some"} error(s)` : null,
      note: !tokens && !runs.n ? "no iMessage collector token (Agents & API)" : null,
    },
    c,
  );
}

const MAC_SOURCES: Array<{ source: string; label: string }> = [
  { source: "voice_memo", label: "Voice memos" },
  { source: "iphone_call", label: "Call recordings" },
  { source: "apple_note", label: "Apple Notes" },
];

async function macRows(pool: pg.Pool, now: Date): Promise<SourceRow[]> {
  const [tokens, runs] = await Promise.all([liveTokens(pool, "ingest:device", "mac_media"), runsOf(pool, "apple_media")]);
  const lastSeenAt = iso(runs.latest?.finished_at ?? runs.latest?.started_at);
  const stale = runs.n > 0 && ago(lastSeenAt, now) > HOUR;
  const out: SourceRow[] = [];
  for (const s of MAC_SOURCES) {
    const c = await itemCounts(pool, `source = $1 and source_payload->>'via' = 'mac_collector'`, [s.source]);
    const latestOut = (runs.latest?.counts_out ?? {}) as Record<string, Record<string, number> | number | string>;
    const errs = ((latestOut.error as Record<string, number> | undefined) ?? {})[s.source] ?? 0;
    const status: SourceStatus = !tokens && !runs.n ? "not_configured" : !runs.n ? "never_run" : errs > 0 ? "erroring" : "live";
    out.push(
      row(
        {
          id: `mac:${s.source}`,
          label: "Mac media collector",
          detail: s.label,
          status,
          warning: stale && status !== "not_configured" ? `the collector has not checked in for ${fmtAge(ago(lastSeenAt, now))} (it runs every 10 minutes: is the Mac asleep or the launchd job unloaded?)` : null,
          lastSuccessAt: iso(runs.ok?.finished_at),
          lastSeenAt,
          lastError: errs > 0 ? `${errs} item(s) failed in the last batch${latestOut.last_error ? `: ${short(latestOut.last_error)}` : ""}` : null,
          note: !tokens && !runs.n ? "no Mac media collector token (Agents & API)" : null,
        },
        c,
      ),
    );
  }
  return out;
}

async function shortcutRow(pool: pg.Pool): Promise<SourceRow> {
  const [tokens, runs, c] = await Promise.all([liveTokens(pool, "ingest:device", "ios_shortcut"), runsOf(pool, "ios_shortcut"), itemCounts(pool, `source_payload->>'via' = 'ios_shortcut'`, [])]);
  const status: SourceStatus = !tokens && !runs.n ? "not_configured" : !runs.n ? "never_run" : runs.latest?.ok === false ? "erroring" : "live";
  const out = (runs.latest?.counts_out ?? {}) as Record<string, unknown>;
  return row(
    {
      id: "ios_shortcut",
      label: "iPhone Shortcut",
      detail: "Send to Vault",
      status,
      warning: null,
      lastSuccessAt: iso(runs.ok?.finished_at),
      lastSeenAt: iso(runs.latest?.finished_at ?? runs.latest?.started_at),
      lastError: status === "erroring" ? `last send failed${out.last_error ? `: ${short(out.last_error)}` : ""}` : null,
      note: !tokens && !runs.n ? "no iPhone Shortcut token (Agents & API)" : "used on demand; no schedule",
    },
    c,
  );
}

// ---- Twilio contractor calls ---------------------------------------------------------------------
async function twilioRow(pool: pg.Pool, config: Config): Promise<SourceRow> {
  const [numbers, calls, c] = await Promise.all([
    pool.query(`select count(*) filter (where status = 'active')::int as active from tracked_numbers`),
    pool.query(
      `select (select max(created_at) from calls) as last_call,
              (select max(created_at) from calls where recording_status = 'stored') as last_stored,
              (select to_jsonb(x) from (select recording_status, recording_error, created_at from calls order by created_at desc limit 1) x) as latest,
              (select count(*)::int from calls) as n`,
    ),
    itemCounts(pool, `source = 'contractor_call'`, []),
  ]);
  const active = numbers.rows[0].active as number;
  const creds = !!(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN);
  const k = calls.rows[0];
  const latest = k.latest as { recording_status?: string; recording_error?: string } | null;
  const status: SourceStatus = !active || !creds ? "not_configured" : !k.n ? "never_run" : latest?.recording_status === "failed" ? "erroring" : "live";
  return row(
    {
      id: "twilio",
      label: "Contractor calls",
      detail: "Twilio tracked numbers",
      status,
      warning: null,
      lastSuccessAt: iso(k.last_stored),
      lastSeenAt: iso(k.last_call),
      lastError: status === "erroring" ? short(latest?.recording_error ?? "the last recording could not be fetched") : null,
      note: !active ? "0 tracked numbers configured (Access & numbers)" : !creds ? "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set" : `${active} tracked number${active === 1 ? "" : "s"}`,
    },
    c,
  );
}
