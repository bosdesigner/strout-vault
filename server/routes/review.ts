import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { countOpenReview, decideReview, decideReviewBulk, listReview, ReviewError, updateDraft } from "../services/review.ts";
import { intId, parse, wrap } from "./util.ts";
import { refileAfterChange } from "../workspaces/refileHook.ts";
import { listAutoApplied, undoAutoApply } from "../services/autoApply.ts";
import { UndoError } from "../services/undo.ts";

/** Approvals that can make a thread's people known; Inbox is re-filed after them. */
const REFILE_AFTER = new Set(["new_party", "participant_match", "link_party_interaction", "party_edit"]);

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
  // What the auto-apply rules applied (docs/AUTO-APPLY.md): the Review page's Auto-applied tab.
  r.get(
    "/auto-applied",
    wrap(async (req, res) => {
      const q = parse(z.object({ days: z.coerce.number().int().min(1).max(90).optional(), workspace: z.string().max(100).optional() }), req.query);
      try {
        res.json({ items: await listAutoApplied(ctx.pool, { days: q.days ?? 7, workspaceId: q.workspace ?? null }) });
      } catch (err) {
        // Before db/migrations/0014_auto_apply.sql is applied there is no log yet.
        if ((err as { code?: string }).code === "42P01") {
          res.json({ items: [], unavailable: true });
          return;
        }
        throw err;
      }
    }),
  );
  r.post(
    "/auto-applied/:id/undo",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      try {
        const out = await undoAutoApply(ctx.pool, id, req.session?.email ?? "owner");
        res.json(out);
      } catch (err) {
        if (err instanceof UndoError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );
  // Approve or reject many items at once (the Review page's "Approve all workspace proposals").
  r.post(
    "/bulk",
    wrap(async (req, res) => {
      const body = parse(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500), decision: z.enum(["approve", "reject"]) }), req.body);
      const out = await decideReviewBulk(ctx.pool, body.ids, body.decision);
      const refiled = body.decision === "approve" && out.done ? await refileAfterChange(ctx) : null;
      res.json({ ...out, refiled, openCount: await countOpenReview(ctx.pool, null) });
    }),
  );
  r.post(
    "/:id/decide",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const { decision } = parse(z.object({ decision: z.enum(["approve", "reject"]) }), req.body);
      try {
        const out = await decideReview(ctx.pool, id, decision);
        const refiled = decision === "approve" && REFILE_AFTER.has(out.item.itemType) ? await refileAfterChange(ctx) : null;
        res.json({ ...out, refiled });
      } catch (err) {
        if (err instanceof ReviewError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );
  // Edit the drafted reply on a follow-through item before sending it.
  r.patch(
    "/:id/draft",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ subject: z.string().max(300).nullable().optional(), body: z.string().min(1).max(20000) }), req.body);
      try {
        res.json({ item: await updateDraft(ctx.pool, id, body) });
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
