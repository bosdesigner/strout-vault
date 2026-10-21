import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { clearSessionCookie, newSession, setSessionCookie } from "../auth/session.ts";
import { parse, wrap } from "./util.ts";

const loginSchema = z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(1000) });

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const sessionOpts = ctx.sessionOptions;

  const loginLimiter = rateLimit({
    windowMs: ctx.config.LOGIN_RATE_WINDOW_MS,
    limit: ctx.config.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Count only failed attempts so a legitimate login does not spend the budget.
    skipSuccessfulRequests: true,
    message: { error: "too_many_attempts", message: "Too many login attempts. Try again later." },
  });

  r.post(
    "/login",
    loginLimiter,
    wrap(async (req, res) => {
      const { email, password } = parse(loginSchema, req.body);
      const principal = await ctx.auth.verifyPassword(email, password);
      if (!principal) {
        res.status(401).json({ error: "invalid_credentials", message: "Wrong email or password." });
        return;
      }
      const session = newSession(principal, ctx.config.SESSION_TTL_SEC);
      setSessionCookie(res, session, sessionOpts);
      res.json({ user: { email: principal.email, role: principal.role }, csrfToken: session.csrf });
    }),
  );

  r.post("/logout", (req, res) => {
    // Logout needs a valid session + CSRF token like every other mutation.
    if (!req.session) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (req.get("x-csrf-token") !== req.session.csrf) {
      res.status(403).json({ error: "csrf_token_invalid" });
      return;
    }
    clearSessionCookie(res, sessionOpts);
    res.json({ ok: true });
  });

  r.get("/me", (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    res.json({ user: { email: req.session.email, role: req.session.role }, csrfToken: req.session.csrf });
  });

  return r;
}
