import { Router } from "express";
import type { AppContext } from "../context.ts";
import { listWorkspaces } from "../services/parties.ts";
import { wrap } from "./util.ts";

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
