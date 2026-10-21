import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { clearSessionCookie, newSession, setSessionCookie } from "../auth/session.ts";
import { parse, wrap } from "./util.ts";

const loginSchema = z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(1000) });
const magicSchema = z.object({ email: z.string().trim().email().max(200) });

function baseUrl(req: { protocol: string; get(h: string): string | undefined }, configured: string): string {
  return configured || `${req.protocol}://${req.get("host")}`;
}

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
      res.json({ user: { email: principal.email, role: principal.role, workspaceId: principal.workspaceId ?? null, partyId: principal.partyId ?? null, displayName: principal.displayName ?? null }, csrfToken: session.csrf });
    }),
  );

  const magicLimiter = rateLimit({
    windowMs: ctx.config.LOGIN_RATE_WINDOW_MS,
    limit: Math.max(3, Math.floor(ctx.config.LOGIN_RATE_LIMIT_MAX / 2)),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "too_many_attempts", message: "Too many sign-in links requested. Try again later." },
  });

  // Contractors: email me a sign-in link. Always 200 so addresses cannot be probed.
  r.post(
    "/magic-link",
    magicLimiter,
    wrap(async (req, res) => {
      const { email } = parse(magicSchema, req.body);
      await ctx.auth.requestMagicLink(email, { ip: req.ip ?? null, baseUrl: baseUrl(req, ctx.config.PUBLIC_URL) });
      res.json({ ok: true, message: "If that address has access, a sign-in link is on its way." });
    }),
  );

  // The link in the email lands here, sets the cookie and sends the browser to the library.
  r.get(
    "/magic",
    wrap(async (req, res) => {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const principal = await ctx.auth.redeemMagicLink(token);
      if (!principal) {
        res.redirect(302, "/login?error=link");
        return;
      }
      const session = newSession(principal, ctx.config.SESSION_TTL_SEC);
      setSessionCookie(res, session, sessionOpts);
      res.redirect(302, "/");
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
    res.json({
      user: {
        email: req.session.email,
        role: req.session.role,
        workspaceId: req.session.workspaceId ?? null,
        partyId: req.session.partyId ?? null,
        displayName: req.session.displayName ?? null,
      },
      csrfToken: req.session.csrf,
    });
  });

  return r;
}
