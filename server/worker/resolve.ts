// The worker's `resolve` step: links Zoom / Meet recordings and iPhone calls to the people on
// them and files the unfiled ones (server/participants/resolve.ts does the work). Runs after
// `transcribe`, so transcript speakers are there, and before `extract`, so extraction reads the
// recording under its workspace with its people on the roster. `npm run resolve:backfill` runs the
// same thing over the whole backlog, with a dry run that rolls everything back.
//
// Zoom's participant list needs a scope the recording app may not have (meeting:read:admin). The
// first refusal is recorded in worker_state (`zoom_participants`) and the call is skipped for a day,
// so a missing scope costs one request a day, not one per recording.
import type pg from "pg";
import type { WorkerContext } from "./context.ts";
import { outOfTime } from "./context.ts";
import { makeZoomClient, zoomConfigured, getState, setState } from "./sync.ts";
import { ZoomError, type ZoomClient } from "./zoom.ts";
import { listMeetAccounts, meetClientFor } from "../meet/sync.ts";
import { CALENDAR_EVENTS_READONLY_SCOPE, type CalendarEvent, type MeetClient } from "../meet/api.ts";
import { gmailConfigured } from "../messages/gmail/sync.ts";
import { ownerIdentity, normalizeEmail, type OwnerIdentity } from "../messages/identity.ts";
import { loadMessageRules } from "../messages/rules.ts";
import { loadFilingRules } from "../workspaces/filing.ts";
import { DEFAULT_OWNER_NAMES, normalizeName, parseTitleNames } from "../participants/names.ts";
import { RESOLVED_SOURCES } from "../ingest/adapters.ts";
import { PartyIndex, resolveInteraction, type InteractionRow, type ResolveDeps, type ResolveResult } from "../participants/resolve.ts";

export interface ResolveSummary {
  checked: number;
  linked: number;
  partiesCreated: number;
  suggested: number;
  leadsLinked: number;
  filed: Record<string, number>;
  /** "ok", "off", "unavailable (…)", or "not needed" when nothing asked for it this run. */
  zoomApi: string;
  calendar: string;
  dryRun: boolean;
  stoppedEarly?: string;
  errors: string[];
  /** Per-interaction results (backfill reports; the hourly run keeps only counts). */
  results?: ResolveResult[];
  inspected?: Record<string, number>;
}

export interface ResolveOptions {
  dryRun?: boolean;
  limit?: number;
  /** Only interactions on or after this date. */
  since?: Date;
  until?: Date;
  /** Re-check interactions already resolved once (the backfill). */
  again?: boolean;
  ids?: number[];
  sources?: string[];
  keepResults?: boolean;
  /** Runs on the step's own connection after the last item, before a dry run rolls back (the backfill's "after" counts). */
  inspect?: (db: pg.PoolClient) => Promise<Record<string, number>>;
}

const ZOOM_STATE = "zoom_participants";
const ZOOM_RECHECK_MS = 24 * 3600_000;

/** Ben's own names: OWNER_NAME, OWNER_NAME_ALIASES and the defaults. */
export function ownerNames(config: { OWNER_NAME?: string; OWNER_NAME_ALIASES?: string }): string[] {
  return [...DEFAULT_OWNER_NAMES, config.OWNER_NAME ?? "", ...(config.OWNER_NAME_ALIASES ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
}

/** Ben's identifiers plus every connected Google account's address. */
export async function ownerWithAccounts(pool: pg.Pool, config: WorkerContext["config"]): Promise<OwnerIdentity> {
  const { rows } = await pool.query(`select distinct account_email from message_accounts`).catch(() => ({ rows: [] as Array<{ account_email: string }> }));
  return ownerIdentity(config, rows.map((r) => r.account_email));
}

/** Zoom participants, or null when the Zoom app cannot read them (recorded once a day). */
function zoomSource(ctx: WorkerContext, summary: ResolveSummary): ResolveDeps["zoomParticipants"] {
  if (!zoomConfigured(ctx) || ctx.config.RESOLVE_ZOOM_PARTICIPANTS !== "1") {
    summary.zoomApi = "off";
    return undefined;
  }
  let client: ZoomClient | null = null;
  let disabled: string | null = null;
  let checked = false;
  return async (uuid) => {
    if (disabled) return null;
    if (!checked) {
      checked = true;
      const state = await getState<{ available: boolean; reason?: string; checkedAt: string }>(ctx, ZOOM_STATE);
      if (state && !state.available && ctx.now().getTime() - new Date(state.checkedAt).getTime() < ZOOM_RECHECK_MS) {
        disabled = state.reason ?? "unavailable";
        summary.zoomApi = `unavailable (${disabled}; next check after ${new Date(new Date(state.checkedAt).getTime() + ZOOM_RECHECK_MS).toISOString().slice(0, 16)}Z)`;
        return null;
      }
    }
    client ??= makeZoomClient(ctx);
    try {
      const list = await client.pastMeetingParticipants(uuid);
      if (summary.zoomApi !== "ok") {
        summary.zoomApi = "ok";
        await setState(ctx, ZOOM_STATE, { available: true, checkedAt: ctx.now().toISOString() });
      }
      return list;
    } catch (err) {
      const status = err instanceof ZoomError ? err.status : undefined;
      // 404 / 3001: this meeting is gone (Zoom keeps past-meeting detail for a limited time). Not a scope problem.
      if (status === 404) return null;
      if (status === 400 || status === 401 || status === 403) {
        disabled = `HTTP ${status}: ${(err as Error).message.replace(/^Zoom API \d+ on \S+: /, "").slice(0, 160)}`;
        summary.zoomApi = `unavailable (${disabled})`;
        await setState(ctx, ZOOM_STATE, { available: false, reason: disabled, checkedAt: ctx.now().toISOString() });
        ctx.log(`resolve: Zoom participant list unavailable, skipped for a day (${disabled}). Add meeting:read:admin to the Zoom app to use it.`);
        return null;
      }
      throw err;
    }
  };
}

/** Picks the event a recording belongs to: overlapping in time, best on a Zoom link and the title's names. */
export function pickCalendarEvent(events: CalendarEvent[], start: Date, title: string | null): CalendarEvent | null {
  const names = parseTitleNames(title).map(normalizeName);
  const scored = events
    .filter((e) => e.start?.dateTime && (e.attendees?.length ?? 0) > 0)
    .map((e) => {
      const text = `${e.location ?? ""} ${e.description ?? ""} ${(e.conferenceData?.entryPoints ?? []).map((p) => p.uri ?? "").join(" ")}`.toLowerCase();
      const summary = normalizeName(e.summary ?? "");
      let score = 0;
      if (/zoom\.us/.test(text)) score += 2;
      if (title && normalizeName(title) && summary === normalizeName(title)) score += 3;
      if (names.some((n) => n && summary.includes(n))) score += 3;
      if (names.some((n) => (e.attendees ?? []).some((a) => normalizeName(a.displayName ?? "") === n))) score += 2;
      const gap = Math.abs(new Date(e.start!.dateTime!).getTime() - start.getTime()) / 60_000;
      score -= Math.min(2, gap / 30);
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  // One event in the window is good enough; with several, it has to look like this call.
  return scored.length === 1 || scored[0].score >= 1 ? scored[0].e : null;
}

async function calendarSource(ctx: WorkerContext, owner: OwnerIdentity, summary: ResolveSummary): Promise<ResolveDeps["calendarAttendees"]> {
  if (ctx.config.RESOLVE_CALENDAR !== "1" || !gmailConfigured(ctx.config)) {
    summary.calendar = "off";
    return undefined;
  }
  const accounts = (await listMeetAccounts(ctx.pool)).filter((a) => a.scope.split(" ").includes(CALENDAR_EVENTS_READONLY_SCOPE));
  if (!accounts.length) {
    summary.calendar = "off (no connected Google account granted calendar.events.readonly)";
    return undefined;
  }
  const clients: MeetClient[] = accounts.map((a) => meetClientFor(ctx, a));
  summary.calendar = `ok (${accounts.map((a) => a.email).join(", ")})`;
  let failures = 0;
  return async (start, end, title) => {
    if (failures >= 3) return null;
    const events: CalendarEvent[] = [];
    for (const c of clients) {
      try {
        events.push(...(await c.events(new Date(start.getTime() - 15 * 60_000), new Date(end.getTime() + 15 * 60_000))));
      } catch (err) {
        failures++;
        summary.errors.push(`calendar: ${(err as Error).message.slice(0, 160)}`);
        if (failures >= 3) summary.calendar = `stopped after 3 failures (${(err as Error).message.slice(0, 120)})`;
      }
    }
    const ev = pickCalendarEvent(events, start, title);
    if (!ev) return [];
    return (ev.attendees ?? [])
      .filter((a) => a.email && !a.self && !a.resource)
      .map((a) => ({ email: normalizeEmail(a.email!)!, name: a.displayName ?? null }))
      .filter((a) => !!a.email && !owner.emails.has(a.email));
  };
}

export async function processResolve(ctx: WorkerContext, opts: ResolveOptions = {}): Promise<ResolveSummary> {
  const summary: ResolveSummary = { checked: 0, linked: 0, partiesCreated: 0, suggested: 0, leadsLinked: 0, filed: {}, zoomApi: "not needed", calendar: "not needed", dryRun: !!opts.dryRun, errors: [] };
  if (opts.keepResults) summary.results = [];
  const owner = await ownerWithAccounts(ctx.pool, ctx.config);
  const deps: ResolveDeps = {
    owner,
    ownerNames: ownerNames(ctx.config),
    rules: loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR),
    filingRules: loadFilingRules(ctx.config.MESSAGES_CONFIG_DIR),
  };
  deps.zoomParticipants = zoomSource(ctx, summary);
  deps.calendarAttendees = await calendarSource(ctx, owner, summary);

  const params: unknown[] = [opts.sources?.length ? opts.sources : [...RESOLVED_SOURCES]];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds = [
    `i.source = any($1::text[])`,
    // Unfiled, in inbox, or nobody linked yet: the gap this step closes.
    `(i.workspace_id is null or i.workspace_id = 'inbox' or not exists (select 1 from interaction_participants ip where ip.interaction_id = i.id))`,
    // Wait for the transcript (speakers), except a recording whose transcription failed for good.
    `coalesce(i.pipeline_status, 'ready') in ('ready', 'failed')`,
  ];
  if (!opts.again) conds.push(`i.participants_resolved_at is null`);
  if (opts.since) conds.push(`i.occurred_at >= ${p(opts.since)}`);
  if (opts.until) conds.push(`i.occurred_at < ${p(opts.until)}`);
  if (opts.ids?.length) conds.push(`i.id = any(${p(opts.ids)}::bigint[])`);
  const limit = Math.max(1, Math.floor(opts.limit ?? ctx.config.RESOLVE_MAX_PER_RUN));
  const { rows } = await ctx.pool.query<InteractionRow>(
    `select i.id, i.title, i.source, i.source_ref, i.kind, i.occurred_at, i.duration_sec, i.workspace_id, i.host_email, i.participants_raw
       from interactions i where ${conds.join(" and ")}
      order by i.occurred_at desc nulls last, i.id desc limit ${limit}`,
    params,
  );
  if (!rows.length) return summary;
  ctx.log(`resolve: ${rows.length} recording(s)/call(s) to link and file${opts.dryRun ? " (dry run, nothing is kept)" : ""}; zoom participants ${summary.zoomApi}, calendar ${summary.calendar}`);

  const db = await ctx.pool.connect();
  try {
    let index = await PartyIndex.load(db);
    if (opts.dryRun) await db.query("begin");
    for (const row of rows) {
      if (outOfTime(ctx)) {
        summary.stoppedEarly = "time budget";
        break;
      }
      try {
        await db.query(opts.dryRun ? "savepoint item" : "begin");
        const r = await resolveInteraction(db, deps, index, row);
        await db.query(opts.dryRun ? "release savepoint item" : "commit");
        summary.checked++;
        summary.linked += r.linked.length;
        summary.partiesCreated += r.linked.filter((l) => l.how === "created").length;
        summary.leadsLinked += r.linked.filter((l) => l.isLead).length;
        summary.suggested += r.suggested.length;
        if (r.workspaceAfter && r.workspaceAfter !== r.workspaceBefore) summary.filed[r.workspaceAfter] = (summary.filed[r.workspaceAfter] ?? 0) + 1;
        summary.results?.push(r);
        if (r.linked.length || r.workspaceAfter !== r.workspaceBefore || r.suggested.length) {
          ctx.log(
            `resolve:   #${row.id} ${row.title ?? ""}: ${r.linked.map((l) => `${l.name} (${l.via}${l.how === "created" ? ", new" : ""}${l.isLead ? ", lead" : ""})`).join(", ") || "nobody"}${r.suggested.length ? `; suggested ${r.suggested.map((s) => `${s.candidate} ≈ ${s.name}`).join(", ")}` : ""}${r.workspaceAfter !== r.workspaceBefore ? `; filed ${r.workspaceAfter} (${r.filedBy})` : ""}`,
          );
        }
      } catch (err) {
        await db.query(opts.dryRun ? "rollback to savepoint item" : "rollback").catch(() => {});
        // A party created inside the rolled-back item is gone again: start from what is really there.
        index = await PartyIndex.load(db);
        const msg = (err as Error).message.slice(0, 300);
        summary.errors.push(`#${row.id}: ${msg}`);
        ctx.log(`resolve:   #${row.id} FAILED ${msg}`);
      }
    }
    if (opts.inspect) summary.inspected = await opts.inspect(db);
  } finally {
    if (opts.dryRun) await db.query("rollback").catch(() => {});
    db.release();
  }
  return summary;
}
