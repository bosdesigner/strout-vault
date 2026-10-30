// Closing a fact by hand (Phase 1 v2): POST /api/facts/:id/status {status: done | dropped | open}.
// Owner only. The follow-through step's done-checks for that fact are closed with it.
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { FactError, setFactStatus } from "../facts/store.ts";
import { intId, parse, wrap } from "./util.ts";

export function factsRouter(ctx: AppContext): Router {
  const r = Router();
  r.post(
    "/:id/status",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ status: z.enum(["done", "dropped", "open"]), interactionId: z.coerce.number().int().positive().optional() }), req.body);
      try {
        const f = await setFactStatus(ctx.pool, id, body.status, body.interactionId ?? null);
        res.json({ fact: { id: Number(f.id), status: f.status, closedAt: f.closed_at ? new Date(f.closed_at as string).toISOString() : null } });
      } catch (err) {
        if (err instanceof FactError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );
  return r;
}
