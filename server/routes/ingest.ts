// /api/ingest: where collectors outside the vault send what they read.
//
// POST /api/ingest/messages: where the iMessage collector on Ben's Mac sends its batches.
// Authenticated by a personal access token carrying ingest:messages (and only that: such a
// token reads nothing and cannot call an MCP tool). The batch goes through the same filter,
// redaction, party matching and routing as Gmail (server/messages/ingest.ts); the collector's
// own filtering is a convenience, never the guard. The response carries counts, never text.
//
// /api/ingest/device/*: the Mac media collector and the iPhone Shortcut (ingest:device tokens):
// presign, finalize, note, runs (server/device/ingest.ts). Responses carry ids and counts.
import express, { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../context.ts";
import { INGEST_DEVICE_SCOPE, verifyIngestToken, type TokenScope } from "../mcp/auth/tokens.ts";
import { LocalStorageDriver } from "../storage/local.ts";
import {
  DeviceError,
  finalizeDevice,
  finalizeSchema,
  finishRun,
  noteSchema,
  presignDevice,
  presignSchema,
  runFinishSchema,
  runStartSchema,
  startRun,
  upsertNote,
  type DeviceCaller,
  type DeviceDeps,
} from "../device/ingest.ts";
import type { ZodType } from "zod";
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

  // ---- /device ------------------------------------------------------------------------------
  const deviceAuth = (scope: TokenScope) => async (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    if (!m) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthenticated" });
      return;
    }
    try {
      const who = await verifyIngestToken(ctx.pool, m[1], scope);
      if (!who) {
        res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
        return;
      }
      if (who === "forbidden") {
        res.status(403).json({ error: "insufficient_scope", message: `this token does not carry ${scope}` });
        return;
      }
      res.locals.caller = { tokenId: who.id, purpose: who.purpose } satisfies DeviceCaller;
      next();
    } catch (err) {
      next(err);
    }
  };
  const deps = (req: Request): DeviceDeps => ({
    pool: ctx.pool,
    storage: ctx.storage,
    owner: ownerIdentity(ctx.config),
    rules: loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR),
    baseUrl: ctx.config.PUBLIC_URL || `${req.protocol}://${req.get("host")}`,
  });
  const handle = <T>(schema: ZodType<T>, fn: (req: Request, body: T, caller: DeviceCaller) => Promise<{ status?: number; body: unknown }>) =>
    async (req: Request, res: Response) => {
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        // Paths and messages only: never echo the submitted values.
        res.status(400).json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) });
        return;
      }
      try {
        const out = await fn(req, parsed.data, res.locals.caller as DeviceCaller);
        res.status(out.status ?? 200).json(out.body);
      } catch (err) {
        if (err instanceof DeviceError) {
          res.status(err.status).json({ error: err.code, message: err.message });
          return;
        }
        console.error(`[ingest] device ${req.path} failed: ${(err as Error).message.slice(0, 200)}`);
        res.status(500).json({ error: "internal_error" });
      }
    };

  const device = Router();
  device.use(limiter, express.json({ limit: "4mb" }));
  // Local storage driver only (development and tests): the part PUT a device client follows.
  // Authenticated by the HMAC signature in the URL alone, exactly like a presigned R2 URL.
  if (ctx.storage instanceof LocalStorageDriver) {
    const driver = ctx.storage;
    device.put("/local/part", async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const k of ["uploadId", "key", "partNumber", "exp"]) {
        if (typeof q[k] !== "string") {
          res.status(400).json({ error: `missing ${k}` });
          return;
        }
        params[k] = q[k] as string;
      }
      if (typeof q.sig !== "string" || !driver.verify(params, q.sig)) {
        res.status(403).json({ error: "bad or expired signature" });
        return;
      }
      try {
        const out = await driver.writePart(params.uploadId, Number(params.partNumber), req);
        res.setHeader("ETag", out.etag);
        res.status(200).end();
      } catch (err) {
        res.status(400).json({ error: (err as Error).message.slice(0, 100) });
      }
    });
  }
  device.use(deviceAuth(INGEST_DEVICE_SCOPE));
  device.post("/presign", handle(presignSchema, async (req, body) => ({ body: await presignDevice(deps(req), body) })));
  device.post("/finalize", handle(finalizeSchema, async (req, body, caller) => {
    const out = await finalizeDevice(deps(req), caller, body);
    return { status: out.duplicate ? 200 : 201, body: out };
  }));
  device.post("/note", handle(noteSchema, async (req, body, caller) => {
    const out = await upsertNote(deps(req), caller, body);
    return { status: out.status === "created" ? 201 : 200, body: out };
  }));
  device.post("/runs", handle(runStartSchema, async (_req, body, caller) => ({ status: 201, body: { run_id: await startRun(ctx.pool, caller, body) } })));
  device.post("/runs/:id/finish", handle(runFinishSchema, async (req, body, caller) => {
    const id = Number(req.params.id);
    const counts = Number.isInteger(id) && id > 0 ? await finishRun(ctx.pool, caller, id, body) : null;
    if (!counts) throw new DeviceError(404, "not_found", "no open run with that id for this token");
    return { body: { ok: true, run_id: id, counts_out: counts } };
  }));
  r.use("/device", device);

  return r;
}
