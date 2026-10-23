import path from "node:path";
import fs from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { Config } from "./config.ts";
import type { DbHandle } from "./db/client.ts";
import type { StorageDriver } from "./storage/types.ts";
import type { AuthProvider } from "./auth/types.ts";
import { attachSession, requireAuth } from "./auth/middleware.ts";
import type { AppContext } from "./context.ts";
import { authRouter } from "./routes/auth.ts";
import { healthRouter } from "./routes/health.ts";
import { interactionsRouter } from "./routes/interactions.ts";
import { searchRouter } from "./routes/search.ts";
import { workspacesRouter } from "./routes/parties.ts";
import { peopleRouter, rolesRouter } from "./routes/people.ts";
import { projectsRouter } from "./routes/projects.ts";
import { reviewRouter } from "./routes/review.ts";
import { clipsRouter } from "./routes/clips.ts";
import { uploadsRouter } from "./routes/uploads.ts";
import { localStorageRouter } from "./routes/localStorage.ts";
import { HttpError } from "./routes/util.ts";
import { requireOwner } from "./auth/scope.ts";
import { membershipsRouter, trackedNumbersRouter, callsRouter } from "./routes/access.ts";
import { twilioWebhooksRouter } from "./routes/twilioWebhooks.ts";
import { pipelineRouter } from "./routes/pipeline.ts";
import type { Mailer } from "./mail/types.ts";
import { MemoryMailer } from "./mail/memory.ts";

export interface CreateAppOptions {
  config: Config;
  dbHandle: DbHandle;
  storage: StorageDriver;
  auth: AuthProvider;
  mailer?: Mailer;
  /** Twilio recordings are fetched with this (tests inject a fake). */
  fetchImpl?: typeof fetch;
  /** Serves the built client from dist/client when true (production). */
  serveStatic?: boolean;
  /** Dev-only hook: mount Vite's middleware for the client. */
  devMiddleware?: (app: Express) => Promise<void>;
}

export async function createApp(opts: CreateAppOptions): Promise<{ app: Express; ctx: AppContext }> {
  const { config, dbHandle, storage, auth } = opts;
  const secure = config.isProd || config.PUBLIC_URL.startsWith("https://");
  const ctx: AppContext = {
    config,
    pool: dbHandle.pool,
    db: dbHandle.db,
    storage,
    auth,
    mailer: opts.mailer ?? new MemoryMailer(false),
    fetchImpl: opts.fetchImpl ?? fetch,
    sessionOptions: { secret: config.SESSION_SECRET, ttlSec: config.SESSION_TTL_SEC, secure },
  };

  const app = express();
  app.disable("x-powered-by");
  // Replit (and most hosts) terminate TLS in front of us; trust one hop for rate limiting and secure cookies.
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: false, // Vite dev + presigned media URLs on other origins; CSP is tuned later.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  app.use(cookieParser());
  app.use(attachSession(config.SESSION_SECRET));

  // Public: liveness + schema version, no secrets. Everything else needs a login.
  app.use(healthRouter(ctx));
  // Public but signature-verified: Twilio voice/status/recording webhooks.
  app.use("/webhooks/twilio", twilioWebhooksRouter(ctx));

  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));
  api.use("/auth", authRouter(ctx));
  // Test-only: the last email the in-memory mailer "sent" (magic links). Never mounted in production.
  if (config.EXPOSE_TEST_MAIL === "1" && !config.isProd) {
    api.get("/_test/last-mail", (_req, res) => {
      const m = ctx.mailer instanceof MemoryMailer ? ctx.mailer.last() : null;
      res.json({ mail: m });
    });
  }
  // Local-driver object routes: the browser PUTs parts and <video> GETs bytes here. They need a
  // session plus the HMAC signature in the URL (like a presigned S3 URL), but no CSRF header,
  // because neither Uppy's part PUT nor a <video> tag can send one.
  if (storage.name === "local") api.use("/storage/local", requireAuth({ csrf: false }), localStorageRouter(ctx));
  api.use(requireAuth());
  api.use("/interactions", interactionsRouter(ctx));
  api.use("/search", searchRouter(ctx));
  api.use("/parties", peopleRouter(ctx));
  api.use("/workspaces", workspacesRouter(ctx));
  api.use("/uploads", uploadsRouter(ctx));
  // Owner-only sections.
  api.use("/roles", requireOwner(), rolesRouter(ctx));
  api.use("/projects", requireOwner(), projectsRouter(ctx));
  api.use("/review", requireOwner(), reviewRouter(ctx));
  api.use("/clips", requireOwner(), clipsRouter(ctx));
  api.use("/memberships", requireOwner(), membershipsRouter(ctx));
  api.use("/tracked-numbers", requireOwner(), trackedNumbersRouter(ctx));
  api.use("/calls", requireOwner(), callsRouter(ctx));
  api.use("/pipeline", requireOwner(), pipelineRouter(ctx));
  api.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...err.extra });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed" || e?.type === "entity.too.large") {
      res.status(e.status ?? 400).json({ error: e.type });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });
  app.use("/api", api);

  if (opts.devMiddleware) {
    await opts.devMiddleware(app);
  } else if (opts.serveStatic !== false) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    const indexHtml = path.join(clientDir, "index.html");
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(clientDir, { index: false, maxAge: "1y", immutable: true, setHeaders(res, p) {
        if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      } }));
      // Every page requires login: unauthenticated visitors get the login screen (the SPA routes them).
      app.get(/.*/, (_req, res) => {
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(indexHtml);
      });
    } else {
      app.get(/.*/, (_req, res) => {
        res.status(503).type("text").send("Client not built. Run `npm run build` first.");
      });
    }
  }

  return { app, ctx };
}
