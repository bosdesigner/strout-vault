// Owner-only: closing a fact by hand (the Done button on a recording, person or project page), so
// the open list stays trustworthy. done = it happened; dropped = it is not happening, or it was
// never a real commitment; open = undo.
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { setFactStatus } from "../facts/store.ts";
import { intId, parse, wrap } from "./util.ts";

export function factsRouter(ctx: AppContext): Router {
  const r = Router();
  r.patch(
    "/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      const body = parse(z.object({ status: z.enum(["open", "done", "dropped"]) }).strict(), req.body);
      const fact = await setFactStatus(ctx.pool, id, body.status);
      if (!fact) {
        res.status(404).json({ error: "fact not found" });
        return;
      }
      res.json({ fact });
    }),
  );
  return r;
}
