import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { searchSegments } from "../services/search.ts";
import { parse, wrap } from "./util.ts";

const schema = z.object({
  q: z.string().max(500).default(""),
  page: z.coerce.number().int().min(1).max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  workspace: z.string().max(100).optional(),
  party: z.coerce.number().int().positive().optional(),
});

export function searchRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    "/",
    wrap(async (req, res) => {
      const q = parse(schema, req.query);
      const out = await searchSegments(ctx.pool, {
        q: q.q,
        page: q.page,
        pageSize: q.pageSize,
        from: q.from,
        to: q.to,
        workspaceId: q.workspace,
        partyId: q.party,
      });
      res.json(out);
    }),
  );
  return r;
}
