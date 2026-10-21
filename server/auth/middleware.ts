import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { SessionData } from "./types.ts";
import { readSession } from "./session.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionData | null;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Attaches req.session (or null) without rejecting. */
export function attachSession(secret: string): RequestHandler {
  return (req, _res, next) => {
    req.session = readSession(req, secret);
    next();
  };
}

/**
 * Every API route requires a valid session. State-changing requests must also
 * carry the session's CSRF token in the X-CSRF-Token header (synchroniser
 * token: the cookie is httpOnly, so only our own pages can read the token).
 */
export function requireAuth(opts: { csrf?: boolean } = {}): RequestHandler {
  const checkCsrf = opts.csrf !== false;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (checkCsrf && !SAFE_METHODS.has(req.method)) {
      const header = req.get("x-csrf-token");
      if (!header || header !== req.session.csrf) {
        res.status(403).json({ error: "csrf_token_invalid" });
        return;
      }
    }
    next();
  };
}
