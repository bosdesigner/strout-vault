import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { buildReport } from "../worker/report.ts";
import { formatRunSummary, type RunSummary } from "../worker/run.ts";
import { HttpError, parse, wrap } from "./util.ts";

/** Owner-only: what the hourly worker did, what is waiting, and a Retry button. */
export function pipelineRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    "/",
    wrap(async (_req, res) => {
      const now = new Date();
      const [report, runs, failed, waiting, state] = await Promise.all([
        buildReport(ctx.pool, now),
        ctx.pool.query(`select id, started_at, finished_at, ok, trigger, host, summary, error from worker_runs order by started_at desc limit 8`),
        ctx.pool.query(
          `select id, title, occurred_at, source, pipeline_error, pipeline_updated_at from interactions
            where pipeline_status = 'failed' order by pipeline_updated_at desc nulls last limit 50`,
        ),
        ctx.pool.query(
          `select i.id, i.title, i.occurred_at, i.source, i.pipeline_status, i.pipeline_error, i.pipeline_updated_at,
                  (select count(*)::int from media m where m.interaction_id = i.id and m.status in ('pending','failed') and m.source = 'zoom') as pending_files
             from interactions i
            where i.pipeline_status in ('queued', 'transcribing')
            order by i.occurred_at desc nulls last limit 50`,
        ),
        ctx.pool.query(`select key, value, updated_at from worker_state where key in ('zoom_cursor_month', 'last_run')`),
      ]);
      const c = ctx.config;
      const stateMap = Object.fromEntries((state.rows as Array<{ key: string; value: unknown }>).map((s) => [s.key, s.value]));
      res.json({
        report,
        lastRuns: (runs.rows as Array<Record<string, unknown>>).map((row) => {
          const summary = (row.summary ?? { durationSec: 0, errors: [] }) as RunSummary;
          return {
            id: row.id,
            startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
            finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
            ok: row.ok,
            trigger: row.trigger,
            durationSec: summary.durationSec ?? null,
            lines: formatRunSummary(summary).split("\n").filter(Boolean),
            errors: summary.errors ?? [],
            skipped: summary.skipped ?? null,
          };
        }),
        failed: (failed.rows as Array<Record<string, unknown>>).map((row) => ({
          id: row.id,
          title: row.title,
          occurredAt: row.occurred_at ? new Date(row.occurred_at as string).toISOString() : null,
          source: row.source,
          error: row.pipeline_error,
          updatedAt: row.pipeline_updated_at ? new Date(row.pipeline_updated_at as string).toISOString() : null,
        })),
        waiting: (waiting.rows as Array<Record<string, unknown>>).map((row) => ({
          id: row.id,
          title: row.title,
          occurredAt: row.occurred_at ? new Date(row.occurred_at as string).toISOString() : null,
          source: row.source,
          status: row.pipeline_status,
          note: row.pipeline_error,
          pendingFiles: row.pending_files,
          updatedAt: row.pipeline_updated_at ? new Date(row.pipeline_updated_at as string).toISOString() : null,
        })),
        config: {
          zoomConfigured: !!(c.ZOOM_ACCOUNT_ID && c.ZOOM_CLIENT_ID && c.ZOOM_CLIENT_SECRET),
          groqConfigured: !!c.GROQ_API_KEY,
          groqBudgetUsd: c.GROQ_API_KEY ? c.GROQ_MONTHLY_BUDGET_USD : 0,
          groqModel: c.GROQ_MODEL,
          transcribePrefer: c.TRANSCRIBE_PREFER,
          archiveStorage: ctx.storage.archiveTarget.storage,
          archiveBucket: ctx.storage.archiveTarget.bucket,
          overlapMonths: c.ZOOM_SYNC_OVERLAP_MONTHS,
        },
        state: {
          zoomCursor: (stateMap.zoom_cursor_month as { month?: string } | undefined)?.month ?? null,
          lastRun: stateMap.last_run ?? null,
        },
      });
    }),
  );

  // Puts a recording back in the queue. Updates only: statuses and attempt counters.
  r.post(
    "/retry",
    wrap(async (req, res) => {
      const body = parse(z.object({ interactionId: z.coerce.number().int().positive() }), req.body);
      const found = await ctx.pool.query(`select id, pipeline_status from interactions where id = $1`, [body.interactionId]);
      if (!found.rows[0]) throw new HttpError(404, "recording not found");
      await ctx.pool.query(`update interactions set pipeline_status = 'queued', pipeline_error = null, pipeline_updated_at = now() where id = $1`, [body.interactionId]);
      await ctx.pool.query(
        `update jobs j set status = 'pending', error = null, attempts = 0, updated_at = now() from media m
          where m.id = j.media_id and m.interaction_id = $1 and j.stage = 'transcribe'`,
        [body.interactionId],
      );
      await ctx.pool.query(
        `update media set status = 'pending', attempts = 0, last_error = null where interaction_id = $1 and source = 'zoom' and status = 'failed'`,
        [body.interactionId],
      );
      res.json({ ok: true, interactionId: body.interactionId, status: "queued" });
    }),
  );

  return r;
}
