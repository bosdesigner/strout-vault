import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { listLibrary, pipelineStatuses } from "../services/library.ts";
import { getRecording, getSegments, linesFromPlainTranscript, updateRecording } from "../services/recording.ts";
import { searchWithinRecording } from "../services/search.ts";
import { servableStorages } from "../services/videoSource.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const SOURCES = ["zoom", "meet", "upload", "iphone_call", "contractor_call"] as const;

const listSchema = z.object({
  cursor: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().optional(),
  workspace: z.string().max(100).optional(),
  party: z.coerce.number().int().positive().optional(),
  hasVideo: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    workspaceId: z.string().max(100).nullable().optional(),
  })
  .strict();

export function interactionsRouter(ctx: AppContext): Router {
  const r = Router();
  const servable = servableStorages((s, k) => ctx.storage.canServe(s, k));

  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(listSchema, req.query);
      const sources = q.source
        ? q.source.split(",").map((s) => s.trim()).filter((s): s is (typeof SOURCES)[number] => (SOURCES as readonly string[]).includes(s))
        : null;
      const page = await listLibrary(
        ctx.pool,
        {
          cursor: q.cursor,
          from: q.from,
          to: q.to,
          sources,
          workspaceId: q.workspace,
          partyId: q.party,
          hasVideo: q.hasVideo === undefined ? null : q.hasVideo === "true",
          limit: q.limit,
        },
        servable,
      );
      res.json(page);
    }),
  );

  r.get(
    "/status",
    wrap(async (req, res) => {
      const ids = String(req.query.ids ?? "")
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 200);
      res.json({ items: await pipelineStatuses(ctx.pool, ids) });
    }),
  );

  r.get(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const rec = await getRecording(ctx.pool, ctx.storage, id);
      if (!rec) throw new HttpError(404, "recording not found");
      res.json(rec);
    }),
  );

  r.get(
    "/:id/segments",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      let lines = await getSegments(ctx.pool, id);
      let anchored = true;
      if (!lines.length) {
        const { rows } = await ctx.pool.query(`select transcript from interactions where id = $1`, [id]);
        if (!rows[0]) throw new HttpError(404, "recording not found");
        if (rows[0].transcript) {
          lines = linesFromPlainTranscript(rows[0].transcript);
          anchored = false;
        }
      }
      res.json({ lines, anchored });
    }),
  );

  r.get(
    "/:id/find",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const q = String(req.query.q ?? "").slice(0, 200);
      res.json({ segmentIds: await searchWithinRecording(ctx.pool, id, q) });
    }),
  );

  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const patch = parse(patchSchema, req.body);
      if (patch.workspaceId) {
        const ws = await ctx.pool.query(`select 1 from workspaces where id = $1`, [patch.workspaceId]);
        if (!ws.rowCount) throw new HttpError(400, "unknown workspace");
      }
      const ok = await updateRecording(ctx.pool, id, patch);
      if (!ok) throw new HttpError(404, "recording not found");
      const rec = await getRecording(ctx.pool, ctx.storage, id);
      res.json(rec);
    }),
  );

  return r;
}
