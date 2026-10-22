import { Router } from "express";
import type { AppContext } from "../context.ts";

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  // Served at two paths: /healthz for local use and most hosts, and /api/health because Google's
  // front end (Replit Autoscale runs on Cloud Run) answers the exact path /healthz itself with a
  // Google 404 page and never forwards it to the container.
  r.get(["/healthz", "/api/health"], async (_req, res) => {
    const out: {
      db: "ok" | "error";
      storage: "ok" | "error";
      storageDriver: string;
      schema: { version: string | null; appliedAt: string | null; entries: number } | null;
      errors?: Record<string, string>;
    } = { db: "error", storage: "error", storageDriver: ctx.storage.name, schema: null };
    const errors: Record<string, string> = {};
    try {
      await ctx.pool.query("select 1");
      out.db = "ok";
      const { rows } = await ctx.pool.query(
        `select change, created_at, (select count(*)::int from schema_log) as entries
         from schema_log order by id desc limit 1`,
      );
      out.schema = rows[0]
        ? { version: rows[0].change, appliedAt: new Date(rows[0].created_at).toISOString(), entries: rows[0].entries }
        : { version: null, appliedAt: null, entries: 0 };
    } catch (err) {
      errors.db = safeMessage(err);
    }
    try {
      await ctx.storage.healthcheck();
      out.storage = "ok";
    } catch (err) {
      errors.storage = safeMessage(err);
    }
    if (Object.keys(errors).length) out.errors = errors;
    res.status(out.db === "ok" && out.storage === "ok" ? 200 : 503).json(out);
  });
  return r;
}

/** Error text without connection strings or credentials. */
function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://…").replace(/AKIA\w+|[A-Za-z0-9/+=]{40,}/g, "…").slice(0, 200);
}
