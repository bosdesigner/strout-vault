import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const statusSchema = z.object({ status: z.enum(["new", "approved", "rejected"]) });

export function clipsRouter(ctx: AppContext): Router {
  const r = Router();
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { status } = parse(statusSchema, req.body);
      // A clip that has already been cut stays cut; everything else may move between new/approved/rejected.
      const out = await ctx.pool.query(
        `update clip_candidates set status = $2 where id = $1 and status <> 'cut'
         returning id, interaction_id, start_sec, end_sec, score, hook, why, status`,
        [id, status],
      );
      if (!out.rows[0]) throw new HttpError(404, "clip candidate not found or already cut");
      const c = out.rows[0];
      res.json({ id: c.id, startSec: c.start_sec, endSec: c.end_sec, score: c.score, hook: c.hook, why: c.why, status: c.status });
    }),
  );
  return r;
}
