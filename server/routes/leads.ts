import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { listLeadPeople } from "../services/leads.ts";
import { parse, wrap } from "./util.ts";

export function leadsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(
        z.object({
          workspace: z.string().max(100).optional(),
          type: z.enum(["homeowner", "contractor", "other"]).optional(),
          followUp: z.enum(["0", "1"]).optional(),
          q: z.string().max(100).optional(),
        }),
        req.query,
      );
      res.json(await listLeadPeople(ctx.pool, { workspaceId: q.workspace, leadType: q.type, followUp: q.followUp === "1", q: q.q }));
    }),
  );
  return r;
}
