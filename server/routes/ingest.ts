// POST /api/ingest/messages: where the iMessage collector on Ben's Mac sends its batches.
// Authenticated by a personal access token carrying ingest:messages (and only that: such a
// token reads nothing and cannot call an MCP tool). The batch goes through the same filter,
// redaction, party matching and routing as Gmail (server/messages/ingest.ts); the collector's
// own filtering is a convenience, never the guard. The response carries counts, never text.
import express, { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.ts";
import { verifyIngestToken } from "../mcp/auth/tokens.ts";
import { ingestBatchSchema, imessageThreads } from "../messages/imessage.ts";
import { countsOut, ingestThreads } from "../messages/ingest.ts";
import { ownerIdentity } from "../messages/identity.ts";
import { loadMessageRules } from "../messages/rules.ts";

export function ingestRouter(ctx: AppContext): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: ctx.config.isTest ? 10_000 : 120, standardHeaders: "draft-7", legacyHeaders: false });

  r.post("/messages", limiter, express.json({ limit: "20mb" }), async (req: Request, res: Response) => {
    const auth = req.get("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthenticated" });
      return;
    }
    const who = await verifyIngestToken(ctx.pool, m[1]);
    if (!who) {
      res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
      return;
    }
    if (who === "forbidden") {
      res.status(403).json({ error: "insufficient_scope", message: "this token does not carry ingest:messages" });
      return;
    }
    const parsed = ingestBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      // Paths and messages only: never echo the submitted values.
      res.status(400).json({ error: "invalid_batch", issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    try {
      const rules = loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR);
      const owner = ownerIdentity(ctx.config);
      const threads = imessageThreads(parsed.data);
      const summary = await ingestThreads(ctx.pool, threads, {
        owner,
        rules,
        importSource: "imessage",
        countsIn: { token: `pat:${who.id}`, collector: parsed.data.collector ?? null, collector_skipped: parsed.data.collector_counts ?? {} },
      });
      res.json({ ok: summary.errors.length === 0, threads: summary.threadsIn, messages: summary.messagesIn, ...countsOut(summary) });
    } catch (err) {
      console.error(`[ingest] messages batch failed: ${(err as Error).message}`);
      res.status(500).json({ error: "internal_error" });
    }
  });

  return r;
}
