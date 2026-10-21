import { Router } from "express";
import type { AppContext } from "../context.ts";
import { getParty, listWorkspaces, suggestParties } from "../services/parties.ts";
import { HttpError, intId, wrap } from "./util.ts";

export function partiesRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const q = String(req.query.q ?? "").slice(0, 100);
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      res.json({ items: await suggestParties(ctx.pool, q, limit) });
    }),
  );
  r.get(
    "/:id",
    wrap(async (req, res) => {
      const party = await getParty(ctx.pool, intId(req.params.id));
      if (!party) throw new HttpError(404, "person not found");
      res.json(party);
    }),
  );
  return r;
}

export function workspacesRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (_req, res) => {
      res.json({ items: await listWorkspaces(ctx.pool) });
    }),
  );
  return r;
}
