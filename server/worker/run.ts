// One worker run: lock, Zoom sync, transcription, embedding, extraction, clips, report. Called hourly by
// the Replit Scheduled Deployment (`npm run worker`), in a loop on a VM, or
// directly from tests.

import os from "node:os";
import type { WorkerContext } from "./context.ts";
import { syncZoom, type SyncSummary } from "./sync.ts";
import { processTranscriptions, type TranscribeSummary } from "./transcribe.ts";
import { processEmbeddings, type EmbedSummary } from "./embed.ts";
import { processScouting, type ScoutSummary } from "./scout.ts";
import { processExtraction, type ExtractSummary } from "./extract.ts";
import { processFollowthrough, type FollowthroughSummary } from "./followthrough.ts";
import { processLeads } from "./leads.ts";
import { processGmail } from "./gmail.ts";
import { processMeet } from "./meet.ts";
import { refileInbox, type RefileSummary } from "../workspaces/refile.ts";
import { processClassify, type ClassifySummary } from "../workspaces/classifyStep.ts";
import { processLink, type LinkSummary } from "../people/link.ts";
import { loadMessageRules } from "../messages/rules.ts";
import { ownerIdentity } from "../messages/identity.ts";
import type { MeetSyncSummary } from "../meet/sync.ts";
import type { GmailSyncSummary } from "../messages/gmail/sync.ts";
import type { LeadSyncSummary } from "../leads/sync.ts";
import { processCuts, type CutSummary } from "./cut.ts";
import { buildReport, type PipelineReport } from "./report.ts";
import { setState } from "./sync.ts";

export type Step = "zoom" | "meet" | "leads" | "gmail" | "transcribe" | "link" | "refile" | "classify" | "embed" | "extract" | "followthrough" | "scout" | "cut" | "report";
/**
 * Ingest, then transcribe, then people (link) and filing (the content classifier with its phalanx guard
 * first, then refile by known people, which never touches what the guard parked in inbox), and only then
 * extraction, so every conversation is read under the workspace it belongs to.
 */
export const ALL_STEPS: Step[] = ["zoom", "meet", "leads", "gmail", "transcribe", "link", "classify", "refile", "embed", "extract", "followthrough", "scout", "cut", "report"];
/**
 * Steps a run may do without the main worker lock: the 10-minute messages deployment runs
 * "gmail,embed" while the hourly run may still be transcribing. Each of those steps takes its
 * own advisory lock, so two of them never overlap.
 */
export const LIGHT_STEPS: Step[] = ["gmail", "link", "classify", "embed"];

export interface RunOptions {
  trigger?: "schedule" | "manual" | "test";
  steps?: Step[];
  dryRun?: boolean;
}

export interface RunSummary {
  zoom?: SyncSummary;
  meet?: MeetSyncSummary;
  refile?: RefileSummary;
  link?: LinkSummary;
  classify?: ClassifySummary;
  leads?: LeadSyncSummary;
  gmail?: GmailSyncSummary;
  transcribe?: TranscribeSummary;
  embed?: EmbedSummary;
  extract?: ExtractSummary;
  followthrough?: FollowthroughSummary;
  scout?: ScoutSummary;
  cut?: CutSummary;
  report?: PipelineReport;
  skipped?: string;
  durationSec: number;
  errors: string[];
  /** What this worker was configured with, so the web app can show the worker's settings rather than its own. */
  config?: WorkerConfigSnapshot;
}

export interface WorkerConfigSnapshot {
  zoomConfigured: boolean;
  groqConfigured: boolean;
  groqBudgetUsd: number;
  groqModel: string;
  transcribePrefer: string;
  archiveStorage: string;
  archiveBucket: string | null;
  overlapMonths: number;
  scoutConfigured?: boolean;
  scoutModel?: string;
  scoutBudgetUsd?: number;
  clipFormat?: string;
  clipCaptions?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string | null;
  extractConfigured?: boolean;
  extractModel?: string;
  extractBudgetUsd?: number;
  extractWorkspaces?: string;
  classifyConfigured?: boolean;
  classifyModel?: string;
  classifyBudgetUsd?: number;
  followthroughConfigured?: boolean;
  followthroughModel?: string;
  followthroughBudgetUsd?: number;
  leadsPlatform?: boolean;
  leadsAirtable?: boolean;
  gmailConfigured?: boolean;
  meetConfigured?: boolean;
}

export function configSnapshot(ctx: WorkerContext): WorkerConfigSnapshot {
  const c = ctx.config;
  return {
    zoomConfigured: !!(c.ZOOM_ACCOUNT_ID && c.ZOOM_CLIENT_ID && c.ZOOM_CLIENT_SECRET),
    groqConfigured: !!c.GROQ_API_KEY,
    groqBudgetUsd: c.GROQ_API_KEY ? c.GROQ_MONTHLY_BUDGET_USD : 0,
    groqModel: c.GROQ_MODEL,
    transcribePrefer: c.TRANSCRIBE_PREFER,
    archiveStorage: ctx.storage.archiveTarget.storage,
    archiveBucket: ctx.storage.archiveTarget.bucket,
    overlapMonths: c.ZOOM_SYNC_OVERLAP_MONTHS,
    scoutConfigured: !!c.ANTHROPIC_API_KEY && c.SCOUT_MONTHLY_BUDGET_USD > 0,
    scoutModel: c.SCOUT_MODEL,
    scoutBudgetUsd: c.ANTHROPIC_API_KEY ? c.SCOUT_MONTHLY_BUDGET_USD : 0,
    clipFormat: c.CLIP_FORMAT,
    clipCaptions: c.CLIP_CAPTIONS === "1",
    extractConfigured: !!c.ANTHROPIC_API_KEY && c.EXTRACT_MONTHLY_BUDGET_USD > 0,
    extractModel: c.EXTRACT_MODEL,
    extractBudgetUsd: c.ANTHROPIC_API_KEY ? c.EXTRACT_MONTHLY_BUDGET_USD : 0,
    extractWorkspaces: c.EXTRACT_WORKSPACES,
    classifyConfigured: !!c.ANTHROPIC_API_KEY && c.CLASSIFY_MONTHLY_BUDGET_USD > 0,
    classifyModel: c.CLASSIFY_MODEL,
    classifyBudgetUsd: c.ANTHROPIC_API_KEY ? c.CLASSIFY_MONTHLY_BUDGET_USD : 0,
    followthroughConfigured: !!c.ANTHROPIC_API_KEY && c.FOLLOWTHROUGH_MONTHLY_BUDGET_USD > 0,
    followthroughModel: c.FOLLOWTHROUGH_MODEL,
    followthroughBudgetUsd: c.ANTHROPIC_API_KEY ? c.FOLLOWTHROUGH_MONTHLY_BUDGET_USD : 0,
    leadsPlatform: !!c.LEADS_DATABASE_URL,
    leadsAirtable: !!c.AIRTABLE_TOKEN,
    gmailConfigured: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.MESSAGES_ENCRYPTION_KEY),
    meetConfigured: !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.MESSAGES_ENCRYPTION_KEY),
    embeddingProvider: c.EMBEDDING_PROVIDER,
    embeddingModel: c.EMBEDDING_PROVIDER === "off" ? null : c.EMBEDDING_MODEL ?? (c.EMBEDDING_PROVIDER === "voyage" ? "voyage-3.5" : c.EMBEDDING_PROVIDER === "openai" ? "text-embedding-3-small" : "fake-hash-1024"),
  };
}

export interface RunResult {
  runId: number | null;
  ok: boolean;
  summary: RunSummary;
}

const LOCK_NAME = "strout-vault-worker";
const LIGHT_LOCK_NAME = "strout-vault-worker-light";

export async function runWorker(ctx: WorkerContext, opts: RunOptions = {}): Promise<RunResult> {
  const steps = opts.steps ?? ALL_STEPS;
  const startedAt = ctx.now();
  const summary: RunSummary = { durationSec: 0, errors: [], config: configSnapshot(ctx) };

  // One run at a time, across machines: a session-level advisory lock.
  const lockClient = await ctx.pool.connect();
  let locked = false;
  try {
    const lockName = steps.every((s) => LIGHT_STEPS.includes(s)) ? LIGHT_LOCK_NAME : LOCK_NAME;
    const r = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [lockName]);
    locked = !!r.rows[0]?.ok;
    if (!locked) {
      ctx.log("another worker run holds the lock; skipping this run");
      summary.skipped = "locked";
      const ins = await ctx.pool.query<{ id: number }>(
        `insert into worker_runs (started_at, finished_at, ok, trigger, host, summary) values ($1, now(), true, $2, $3, $4) returning id`,
        [startedAt, opts.trigger ?? "schedule", os.hostname(), JSON.stringify(summary)],
      );
      return { runId: ins.rows[0].id, ok: true, summary };
    }

    const ins = await ctx.pool.query<{ id: number }>(`insert into worker_runs (started_at, trigger, host) values ($1, $2, $3) returning id`, [
      startedAt,
      opts.trigger ?? "schedule",
      os.hostname(),
    ]);
    const runId = ins.rows[0].id;
    ctx.log(`run #${runId} started (${steps.join(", ")}${opts.dryRun ? ", dry run" : ""})`);

    let ok = true;
    for (const step of steps) {
      try {
        if (step === "zoom") summary.zoom = await syncZoom(ctx, { dryRun: opts.dryRun });
        else if (step === "meet") summary.meet = await processMeet(ctx, { dryRun: opts.dryRun });
        else if (step === "refile" && !opts.dryRun) summary.refile = await refileInbox(ctx.pool, loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR), ownerIdentity(ctx.config));
        else if (step === "link" && !opts.dryRun) summary.link = await processLink(ctx);
        else if (step === "classify" && !opts.dryRun) summary.classify = await processClassify(ctx);
        else if (step === "leads") summary.leads = await processLeads(ctx, { dryRun: opts.dryRun });
        else if (step === "gmail") summary.gmail = await processGmail(ctx, { dryRun: opts.dryRun });
        else if (step === "transcribe" && !opts.dryRun) summary.transcribe = await processTranscriptions(ctx);
        else if (step === "embed" && !opts.dryRun) summary.embed = await processEmbeddings(ctx);
        else if (step === "extract" && !opts.dryRun) summary.extract = await processExtraction(ctx);
        else if (step === "followthrough" && !opts.dryRun) summary.followthrough = await processFollowthrough(ctx);
        else if (step === "scout" && !opts.dryRun) summary.scout = await processScouting(ctx);
        else if (step === "cut" && !opts.dryRun) summary.cut = await processCuts(ctx);
        else if (step === "report") summary.report = await buildReport(ctx.pool, ctx.now());
      } catch (err) {
        ok = false;
        const msg = (err as Error).message.slice(0, 1000);
        summary.errors.push(`${step}: ${msg}`);
        ctx.log(`${step}: run-level error: ${msg}`);
      }
    }
    summary.durationSec = Math.round((ctx.now().getTime() - startedAt.getTime()) / 1000);
    await ctx.pool.query(`update worker_runs set finished_at = now(), ok = $2, summary = $3, error = $4 where id = $1`, [
      runId,
      ok,
      JSON.stringify(summary),
      summary.errors.length ? summary.errors.join("\n").slice(0, 4000) : null,
    ]);
    await setState(ctx, "last_run", { id: runId, ok, finishedAt: ctx.now().toISOString(), trigger: opts.trigger ?? "schedule" });
    ctx.log(`run #${runId} ${ok ? "finished" : "finished with errors"} in ${summary.durationSec}s`);
    return { runId, ok, summary };
  } finally {
    if (locked) await lockClient.query(`select pg_advisory_unlock(hashtext($1))`, [steps.every((s) => LIGHT_STEPS.includes(s)) ? LIGHT_LOCK_NAME : LOCK_NAME]).catch(() => {});
    lockClient.release();
  }
}

/** Short human summary for the deployment log. */
export function formatRunSummary(s: RunSummary): string {
  const lines: string[] = [];
  if (s.skipped) lines.push(`skipped: ${s.skipped}`);
  if (s.zoom) {
    const z = s.zoom;
    lines.push(
      z.configured
        ? `zoom: ${z.recordingsSeen} seen, ${z.recordingsNew} new, ${z.filesQueued} file(s) queued; downloaded ${z.filesVerified + z.filesStable} ok, ${z.filesFailed} failed (${(z.bytes / 1024 / 1024).toFixed(1)} MB)${z.stoppedEarly ? `; stopped early: ${z.stoppedEarly}` : ""}`
        : "zoom: not configured",
    );
  }
  if (s.meet) {
    const m = s.meet;
    lines.push(
      m.skipped
        ? `meet: off (${m.skipped})`
        : `meet: ${m.accounts.map((a) => `${a.account} ${a.error ? "FAILED" : a.capability === "none_found" ? "no recordings" : `${a.recordingsNew} new of ${a.recordingsSeen}`}`).join(", ")}; downloaded ${m.filesVerified} ok, ${m.filesFailed} failed (${(m.bytes / 1024 / 1024).toFixed(1)} MB)${m.dryRun ? ` (dry run, would download ${(m.bytesPending / 1024 / 1024).toFixed(1)} MB)` : ""}${m.stoppedEarly ? `; stopped early: ${m.stoppedEarly}` : ""}`,
    );
  }
  if (s.refile) {
    const f = Object.entries(s.refile.filed);
    lines.push(`inbox: ${s.refile.checked} item(s) checked, ${f.length ? `filed ${f.map(([k, v]) => `${k} ${v}`).join(", ")}` : "none filed"}`);
  }
  if (s.link) {
    const k = s.link;
    lines.push(`link: ${k.linked}/${k.candidates} interaction(s) got people (${Object.entries(k.bySource).map(([a, b]) => `${a} ${b}`).join(", ") || "none"}), ${k.suggested} suggestion(s), ${k.retitled} call(s) retitled; zoom participants ${k.zoomApi}, calendar ${k.calendar}${k.stoppedEarly ? `; stopped early: ${k.stoppedEarly}` : ""}`);
  }
  if (s.classify) {
    const c = s.classify;
    lines.push(
      `classify: ${c.classified}/${c.candidates} classified, filed ${Object.entries(c.filed).map(([a, b]) => `${a} ${b}`).join(", ") || "none"}; ${c.inbox} left in inbox (${c.reviewQueued} review item(s)), ${c.phalanxGuarded} moved by the phalanx guard; Claude read ${c.llmItems}${c.configured ? "" : " (off: set CLASSIFY_MONTHLY_BUDGET_USD)"}, ${c.waitingOnBudget} waiting, ${c.failed} failed, $${c.spentUsd.toFixed(3)} spent${c.stoppedEarly ? `; stopped early: ${c.stoppedEarly}` : ""}`,
    );
  }
  if (s.leads) {
    const l = s.leads;
    const srcs = Object.entries(l.sources).filter(([, v]) => v.configured);
    lines.push(
      srcs.length
        ? `leads: ${srcs.map(([k, v]) => `${k} ${v.error ? "FAILED" : v.read}`).join(", ")}; ${l.leads} lead(s), ${l.newLeads} new, ${l.partiesCreated} new part(ies), ${l.partiesMatched} matched, ${l.callLinksQueued} call link(s) queued${l.dryRun ? " (dry run, nothing written)" : ""}`
        : "leads: off (no source configured)",
    );
  }
  if (s.gmail) {
    const g = s.gmail;
    const i = g.ingest;
    lines.push(
      g.skipped
        ? `gmail: off (${g.skipped})`
        : `gmail: ${g.accounts.map((a) => `${a.account} ${a.error ? "FAILED" : `${a.mode} ${a.threads}`}`).join(", ")}; ${i.created} new thread(s), ${i.updated} updated, ${i.unchanged} unchanged; skipped ${Object.entries(i.skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${i.reviewNewParty} unknown sender(s), ${i.reviewWorkspace} workspace decision(s) queued${g.dryRun ? " (dry run, nothing written)" : ""}${g.stoppedEarly ? `; stopped early: ${g.stoppedEarly}` : ""}`,
    );
  }
  if (s.transcribe) {
    const t = s.transcribe;
    lines.push(
      `transcribe: ${t.done}/${t.candidates} done (zoom transcript ${t.viaZoomTranscript}, captions ${t.viaZoomCaptions}${t.viaMeetTranscript ? `, meet transcript ${t.viaMeetTranscript}` : ""}, groq ${t.viaGroq}), ${t.waitingOnBudget} waiting on budget, ${t.failed} failed, $${t.spentUsd.toFixed(3)} spent${t.stoppedEarly ? `; stopped early: ${t.stoppedEarly}` : ""}`,
    );
  }
  if (s.embed) {
    const e = s.embed;
    lines.push(
      e.configured
        ? `embed: ${e.done}/${e.candidates} recording(s) embedded into ${e.chunks} chunk(s) (~${e.tokens} tokens, ~$${e.estimatedUsd.toFixed(3)} on ${e.provider} ${e.model}), ${e.failed} failed${e.stoppedEarly ? `; stopped early: ${e.stoppedEarly}` : ""}`
        : `embed: off${e.candidates ? ` (${e.candidates} recording(s) waiting)` : ""}`,
    );
  }
  if (s.extract) {
    const x = s.extract;
    lines.push(
      x.configured
        ? `extract: ${x.read}/${x.candidatesRecordings + (x.candidatesThreads ?? 0)} item(s) read (${x.threads ?? 0} thread(s)), ${x.facts?.created ?? 0} fact(s) written (+${x.facts?.linked ?? 0} linked to an existing fact), queued for review ${x.queued.facts} fact(s), ${x.queued.speakers} speaker match(es), ${x.queued.projects} project link(s); ${x.waitingOnBudget} waiting on budget, ${x.failed} failed, $${x.spentUsd.toFixed(3)} spent${x.stoppedEarly ? `; stopped early: ${x.stoppedEarly}` : ""}`
        : `extract: off${x.candidatesRecordings || x.candidatesThreads ? ` (${x.candidatesRecordings} recording(s)${x.candidatesThreads ? ` and ${x.candidatesThreads} thread(s)` : ""} waiting)` : ""}`,
    );
  }
  if (s.followthrough) {
    const f = s.followthrough;
    const seen = `${f.candidates.replies} waiting on a reply, ${f.candidates.commitments} open commitment(s), ${f.candidates.quiet} gone quiet`;
    lines.push(
      f.configured
        ? `followthrough: ${seen}; queued ${f.queued.replies} reply(ies), ${f.queued.done} done, ${f.queued.nudges} nudge(s)${f.skippedNoReply ? `, ${f.skippedNoReply} needing no reply` : ""}; ${f.checked} checked, ${f.calls} call(s), ${f.failed} failed, $${f.spentUsd.toFixed(3)} spent${f.stoppedEarly ? `; stopped early: ${f.stoppedEarly}` : ""}`
        : `followthrough: off (${seen})`,
    );
  }
  if (s.scout) {
    const c = s.scout;
    lines.push(
      c.configured
        ? `scout: ${c.scanned}/${c.candidatesRecordings} recording(s) read, ${c.found} candidate(s) found, ${c.waitingOnBudget} waiting on budget, ${c.failed} failed, $${c.spentUsd.toFixed(3)} spent${c.stoppedEarly ? `; stopped early: ${c.stoppedEarly}` : ""}`
        : `scout: off${c.candidatesRecordings ? ` (${c.candidatesRecordings} recording(s) waiting)` : ""}`,
    );
  }
  if (s.cut) {
    const k = s.cut;
    lines.push(`clips: ${k.rendered}/${k.approved} approved clip(s) rendered, ${k.failed} failed (${(k.bytes / 1024 / 1024).toFixed(1)} MB)${k.stoppedEarly ? `; stopped early: ${k.stoppedEarly}` : ""}`);
  }
  if (s.report) {
    const r = s.report;
    lines.push(
      `queue: ${r.queue.queued} queued, ${r.queue.transcribing} transcribing, ${r.queue.failed} failed, ${r.queue.ready} ready; ${r.downloads.pending + r.downloads.failed} download(s) pending; ${r.missingOffsite.total} recording(s) without an off-site copy; groq this month $${r.spend.groqUsd.toFixed(2)}${r.clips ? `; clips: ${r.clips.toReview} to review, ${r.clips.approved} approved, ${r.clips.cut} cut; claude this month $${(r.spend.anthropicUsd ?? 0).toFixed(2)}` : ""}`,
    );
  }
  // Per-item errors from each step, a few of them: the full lists live in the run's summary JSON.
  const itemErrors = [...(s.link?.errors ?? []), ...(s.classify?.errors ?? []), ...(s.zoom?.errors ?? []), ...(s.meet?.errors ?? []), ...(s.leads?.errors ?? []), ...(s.gmail?.errors ?? []), ...(s.gmail?.ingest.errors ?? []), ...(s.transcribe?.errors ?? []), ...(s.embed?.errors ?? []), ...(s.extract?.errors ?? []), ...(s.followthrough?.errors ?? []), ...(s.scout?.errors ?? []), ...(s.cut?.errors ?? [])];
  if (itemErrors.length) {
    const shown = itemErrors.slice(0, 3);
    lines.push(`errors: ${shown.join(" | ")}${itemErrors.length > shown.length ? ` | …and ${itemErrors.length - shown.length} more` : ""}`);
  }
  if (s.errors.length) lines.push(`errors: ${s.errors.join(" | ")}`);
  return lines.join("\n");
}
