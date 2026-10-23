// One worker run: lock, Zoom sync, transcription, report. Called hourly by
// the Replit Scheduled Deployment (`npm run worker`), in a loop on a VM, or
// directly from tests.

import os from "node:os";
import type { WorkerContext } from "./context.ts";
import { syncZoom, type SyncSummary } from "./sync.ts";
import { processTranscriptions, type TranscribeSummary } from "./transcribe.ts";
import { buildReport, type PipelineReport } from "./report.ts";
import { setState } from "./sync.ts";

export type Step = "zoom" | "transcribe" | "report";

export interface RunOptions {
  trigger?: "schedule" | "manual" | "test";
  steps?: Step[];
  dryRun?: boolean;
}

export interface RunSummary {
  zoom?: SyncSummary;
  transcribe?: TranscribeSummary;
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
  };
}

export interface RunResult {
  runId: number | null;
  ok: boolean;
  summary: RunSummary;
}

const LOCK_NAME = "strout-vault-worker";

export async function runWorker(ctx: WorkerContext, opts: RunOptions = {}): Promise<RunResult> {
  const steps = opts.steps ?? ["zoom", "transcribe", "report"];
  const startedAt = ctx.now();
  const summary: RunSummary = { durationSec: 0, errors: [], config: configSnapshot(ctx) };

  // One run at a time, across machines: a session-level advisory lock.
  const lockClient = await ctx.pool.connect();
  let locked = false;
  try {
    const r = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [LOCK_NAME]);
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
        else if (step === "transcribe" && !opts.dryRun) summary.transcribe = await processTranscriptions(ctx);
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
    if (locked) await lockClient.query(`select pg_advisory_unlock(hashtext($1))`, [LOCK_NAME]).catch(() => {});
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
  if (s.transcribe) {
    const t = s.transcribe;
    lines.push(
      `transcribe: ${t.done}/${t.candidates} done (zoom transcript ${t.viaZoomTranscript}, captions ${t.viaZoomCaptions}, groq ${t.viaGroq}), ${t.waitingOnBudget} waiting on budget, ${t.failed} failed, $${t.spentUsd.toFixed(3)} spent${t.stoppedEarly ? `; stopped early: ${t.stoppedEarly}` : ""}`,
    );
  }
  if (s.report) {
    const r = s.report;
    lines.push(
      `queue: ${r.queue.queued} queued, ${r.queue.transcribing} transcribing, ${r.queue.failed} failed, ${r.queue.ready} ready; ${r.downloads.pending + r.downloads.failed} download(s) pending; ${r.missingOffsite.total} recording(s) without an off-site copy; groq this month $${r.spend.groqUsd.toFixed(2)}`,
    );
  }
  // Per-item errors from each step, a few of them: the full lists live in the run's summary JSON.
  const itemErrors = [...(s.zoom?.errors ?? []), ...(s.transcribe?.errors ?? [])];
  if (itemErrors.length) {
    const shown = itemErrors.slice(0, 3);
    lines.push(`errors: ${shown.join(" | ")}${itemErrors.length > shown.length ? ` | …and ${itemErrors.length - shown.length} more` : ""}`);
  }
  if (s.errors.length) lines.push(`errors: ${s.errors.join(" | ")}`);
  return lines.join("\n");
}
