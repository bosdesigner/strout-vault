import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const statusSchema = z.object({ status: z.enum(["new", "approved", "rejected"]) });

const LIST_SELECT = `
  select c.id, c.interaction_id, c.start_sec, c.end_sec, c.score, c.hook, c.why, c.platforms, c.status, c.model, c.created_at,
         c.clip_media_id, c.clip_path, c.rendered_at, c.render_attempts, c.render_error, c.approved_at,
         i.title, i.occurred_at, i.source, i.workspace_id,
         m.bytes as clip_bytes, m.duration_sec as clip_duration
    from clip_candidates c
    join interactions i on i.id = c.interaction_id
    left join media m on m.id = c.clip_media_id`;

function row(r: Record<string, unknown>) {
  return {
    id: r.id,
    interactionId: r.interaction_id,
    title: r.title,
    occurredAt: r.occurred_at ? new Date(r.occurred_at as string).toISOString() : null,
    source: r.source,
    workspaceId: r.workspace_id,
    startSec: r.start_sec,
    endSec: r.end_sec,
    score: r.score,
    hook: r.hook,
    why: r.why,
    platforms: typeof r.platforms === "string" && r.platforms ? (r.platforms as string).split(",") : [],
    status: r.status,
    model: r.model,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    approvedAt: r.approved_at ? new Date(r.approved_at as string).toISOString() : null,
    renderedAt: r.rendered_at ? new Date(r.rendered_at as string).toISOString() : null,
    renderAttempts: r.render_attempts ?? 0,
    renderError: r.render_error ?? null,
    // Downloadable when the worker rendered it into the bucket; legacy clips cut on the Mac have a path but no media.
    clipMediaId: r.clip_media_id ?? null,
    clipPath: r.clip_path ?? null,
    clipBytes: r.clip_bytes ?? null,
    clipDurationSec: r.clip_duration ?? null,
  };
}

/** Owner-only: clip candidates (review, approved, finished) and downloads. */
export function clipsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(
        z.object({
          status: z.enum(["new", "approved", "rejected", "cut"]).default("new"),
          workspace: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        req.query,
      );
      const params: unknown[] = [q.status];
      let where = `c.status = $1`;
      if (q.workspace) {
        params.push(q.workspace);
        where += ` and i.workspace_id = $${params.length}`;
      }
      params.push(q.limit);
      const order = q.status === "new" ? "c.score desc, i.occurred_at desc nulls last, c.id" : q.status === "cut" ? "c.rendered_at desc nulls last, c.id desc" : "c.approved_at desc nulls last, c.id desc";
      const { rows } = await ctx.pool.query(`${LIST_SELECT} where ${where} order by ${order} limit $${params.length}`, params);
      const counts = await ctx.pool.query(`select status, count(*)::int as n from clip_candidates group by status`);
      res.json({
        items: rows.map(row),
        counts: Object.fromEntries((counts.rows as Array<{ status: string; n: number }>).map((c) => [c.status, c.n])),
      });
    }),
  );

  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { status } = parse(statusSchema, req.body);
      // A clip that has already been cut stays cut; everything else may move between new/approved/rejected.
      const out = await ctx.pool.query(
        `update clip_candidates set status = $2, approved_at = case when $2 = 'approved' then now() else approved_at end
          where id = $1 and status <> 'cut'
         returning id, interaction_id, start_sec, end_sec, score, hook, why, status, clip_media_id`,
        [id, status],
      );
      if (!out.rows[0]) throw new HttpError(404, "clip candidate not found or already cut");
      const c = out.rows[0];
      res.json({ id: c.id, startSec: c.start_sec, endSec: c.end_sec, score: c.score, hook: c.hook, why: c.why, status: c.status, clipMediaId: c.clip_media_id ?? null });
    }),
  );

  // Puts a failed render back in the queue (updates only).
  r.post(
    "/:id/rerender",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const out = await ctx.pool.query(
        `update clip_candidates set render_attempts = 0, render_error = null where id = $1 and status = 'approved' and clip_media_id is null returning id`,
        [id],
      );
      if (!out.rows[0]) throw new HttpError(404, "no approved, unrendered clip with that id");
      res.json({ ok: true, id });
    }),
  );

  // A short-lived URL for the rendered MP4.
  r.get(
    "/:id/download",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { rows } = await ctx.pool.query(
        `select m.storage, m.bucket, m.storage_key, m.bytes, c.hook from clip_candidates c join media m on m.id = c.clip_media_id where c.id = $1`,
        [id],
      );
      const m = rows[0];
      if (!m) throw new HttpError(404, "this clip has not been rendered by the worker");
      const signed = await ctx.storage.presignGet({ storage: m.storage, bucket: m.bucket, key: m.storage_key }, { expiresInSec: 3600 });
      if (!signed) throw new HttpError(409, "the clip's storage is not reachable from this app");
      res.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString(), filename: String(m.storage_key).split("/").pop(), bytes: m.bytes });
    }),
  );

  return r;
}
