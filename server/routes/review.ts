import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { countOpenReview, decideReview, decideReviewBulk, listReview, ReviewError } from "../services/review.ts";
import { intId, parse, wrap } from "./util.ts";

export function reviewRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(z.object({ status: z.enum(["open", "approved", "rejected", "all"]).optional(), workspace: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
      const [items, open] = await Promise.all([
        listReview(ctx.pool, { status: q.status ?? "open", workspaceId: q.workspace, limit: q.limit }),
        countOpenReview(ctx.pool, q.workspace),
      ]);
      res.json({ items, openCount: open });
    }),
  );
  r.get(
    "/count",
    wrap(async (req, res) => {
      res.json({ openCount: await countOpenReview(ctx.pool, typeof req.query.workspace === "string" ? req.query.workspace : null) });
    }),
  );
  // Approve or reject many items at once (the Review page's "Approve all workspace proposals").
  r.post(
    "/bulk",
    wrap(async (req, res) => {
      const body = parse(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500), decision: z.enum(["approve", "reject"]) }), req.body);
      const out = await decideReviewBulk(ctx.pool, body.ids, body.decision);
      res.json({ ...out, openCount: await countOpenReview(ctx.pool, null) });
    }),
  );
  r.post(
    "/:id/decide",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { decision } = parse(z.object({ decision: z.enum(["approve", "reject"]) }), req.body);
      try {
        res.json(await decideReview(ctx.pool, id, decision));
      } catch (err) {
        if (err instanceof ReviewError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );
  return r;
}
