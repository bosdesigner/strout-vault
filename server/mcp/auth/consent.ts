// The consent screen for OAuth clients (Claude.ai custom connectors). The SDK's /authorize
// handler validates the client and redirects here with a signed, 10-minute request. The
// owner signs in with the app's normal email + password (same provider, same session
// cookie), picks the workspaces the connector may read, and approves or denies. phalanx is
// unchecked by default and never implied by "all workspaces".
import { Router, urlencoded, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { AppContext } from "../../context.ts";
import { newSession, setSessionCookie } from "../../auth/session.ts";
import { RESTRICTED_WORKSPACES, parseStoredScope } from "../scope.ts";
import { verifyPending, type PendingAuthorization, type VaultOAuthProvider } from "./oauth.ts";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Strout Vault</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #666; --line: #ddd; --accent: #2563eb; --warn: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --muted: #999; --line: #333; --accent: #60a5fa; --warn: #fbbf24; } }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 30rem; margin: 8vh auto; padding: 0 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; } p { margin: .5rem 0; } .muted { color: var(--muted); font-size: .92rem; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin-top: 1rem; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 500; } input[type=text], input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: 8px; font: inherit; background: transparent; color: inherit; }
  .ws { display: flex; gap: .6rem; align-items: flex-start; padding: .45rem 0; border-top: 1px solid var(--line); } .ws:first-of-type { border-top: 0; } .ws input { margin-top: .3rem; }
  .ws small { display: block; color: var(--muted); } .restricted small { color: var(--warn); }
  .actions { display: flex; gap: .6rem; margin-top: 1.1rem; } button { font: inherit; padding: .6rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; } .error { color: #b91c1c; }
  code { font-size: .9em; }
</style></head><body><main>${body}</main></body></html>`;
}

function errorPage(res: Response, status: number, message: string) {
  res.status(status).type("html").send(page("Cannot continue", `<h1>Cannot continue</h1><p>${esc(message)}</p><p class="muted">Close this window and start the connection again from the app that sent you here.</p>`));
}

export function consentRouter(ctx: AppContext, provider: VaultOAuthProvider): Router {
  const r = Router();
  const secret = ctx.config.SESSION_SECRET;
  // Only the consent forms post urlencoded bodies; keep the parser off every other path.
  r.use("/oauth/consent", urlencoded({ extended: false }));

  const loginLimiter = rateLimit({
    windowMs: ctx.config.LOGIN_RATE_WINDOW_MS,
    limit: ctx.config.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => errorPage(res, 429, "Too many sign-in attempts. Try again later."),
  });

  async function loadClient(p: PendingAuthorization) {
    const c = await provider.clientsStore.getClient(p.clientId);
    return c ?? null;
  }

  // Step 1: the browser arrives from /authorize. Sign in if needed, then choose workspaces.
  r.get("/oauth/consent", async (req, res) => {
    const pending = verifyPending(typeof req.query.req === "string" ? req.query.req : undefined, secret);
    if (!pending) return errorPage(res, 400, "This authorization request is missing, invalid or has expired (they last 10 minutes).");
    const client = await loadClient(pending);
    if (!client) return errorPage(res, 400, "The application that asked for access is no longer registered.");
    const reqToken = String(req.query.req);
    const clientName = client.client_name ?? client.client_id;
    const session = req.session;
    if (!session || session.role !== "owner") {
      const reason = session ? `<p class="error">Signed in as ${esc(session.email)}, but only the vault owner can connect agents.</p>` : "";
      res.type("html").send(
        page(
          "Sign in",
          `<h1>Sign in to Strout Vault</h1><p class="muted"><strong>${esc(clientName)}</strong> wants to read your conversation archive. Sign in with your owner account to choose what it may see.</p>
<div class="card"><form method="post" action="/oauth/consent/login">${reason}
<input type="hidden" name="req" value="${esc(reqToken)}">
<label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<div class="actions"><button class="primary" type="submit">Sign in</button></div></form></div>`,
        ),
      );
      return;
    }
    const { rows } = await ctx.pool.query(`select id, name, notes from workspaces order by name`);
    const restricted = new Set<string>(RESTRICTED_WORKSPACES);
    const redirectHost = (() => {
      try {
        return new URL(pending.redirectUri).host;
      } catch {
        return pending.redirectUri;
      }
    })();
    const boxes = rows
      .map(
        (w) => `<label class="ws${restricted.has(w.id) ? " restricted" : ""}"><input type="checkbox" name="workspace" value="${esc(w.id)}"${restricted.has(w.id) ? "" : " checked"}>
<span><strong>${esc(w.name)}</strong> <code>${esc(w.id)}</code>${restricted.has(w.id) ? "<small>Investor material: not included unless you tick it.</small>" : w.notes ? `<small>${esc(w.notes)}</small>` : ""}</span></label>`,
      )
      .join("");
    res.type("html").send(
      page(
        "Allow access",
        `<h1>Allow ${esc(clientName)} to read your vault?</h1>
<p class="muted">Signed in as ${esc(session.email)}. The connector gets read access to the workspaces you tick, plus the ability to <em>propose</em> changes for your review queue. It cannot edit records, send email or touch anything else. After approval the browser returns to <code>${esc(redirectHost)}</code>.</p>
<div class="card"><form method="post" action="/oauth/consent/decide">
<input type="hidden" name="req" value="${esc(reqToken)}"><input type="hidden" name="csrf" value="${esc(session.csrf)}">
<p><strong>Workspaces</strong></p>${boxes}
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form></div>
<p class="muted">You can revoke this connection any time under Agents &amp; API in the account menu.</p>`,
      ),
    );
  });

  // Owner password login for the consent screen: the same provider the app's login uses.
  r.post("/oauth/consent/login", loginLimiter, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const pending = verifyPending(body.req, secret);
    if (!pending) return errorPage(res, 400, "This authorization request is missing, invalid or has expired.");
    const email = String(body.email ?? "").slice(0, 200);
    const password = String(body.password ?? "").slice(0, 1000);
    const principal = email && password ? await ctx.auth.verifyPassword(email, password) : null;
    if (!principal || principal.role !== "owner") {
      res.status(401).type("html").send(
        page(
          "Sign in",
          `<h1>Sign in to Strout Vault</h1><div class="card"><form method="post" action="/oauth/consent/login"><p class="error">Wrong email or password.</p>
<input type="hidden" name="req" value="${esc(body.req ?? "")}">
<label for="email">Email</label><input id="email" type="email" name="email" value="${esc(email)}" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
<div class="actions"><button class="primary" type="submit">Sign in</button></div></form></div>`,
        ),
      );
      return;
    }
    setSessionCookie(res, newSession(principal, ctx.config.SESSION_TTL_SEC), ctx.sessionOptions);
    res.redirect(303, `/oauth/consent?req=${encodeURIComponent(body.req)}`);
  });

  // Step 2: approve (mint a code) or deny.
  r.post("/oauth/consent/decide", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | string[]>;
    const pending = verifyPending(typeof body.req === "string" ? body.req : undefined, secret);
    if (!pending) return errorPage(res, 400, "This authorization request is missing, invalid or has expired.");
    const session = req.session;
    if (!session || session.role !== "owner") return errorPage(res, 401, "Sign in as the owner first.");
    if (body.csrf !== session.csrf) return errorPage(res, 403, "The form has expired. Start again from the app.");
    const client = await loadClient(pending);
    if (!client) return errorPage(res, 400, "The application that asked for access is no longer registered.");
    const target = new URL(pending.redirectUri);
    if (body.decision !== "approve") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "The owner denied the request");
      if (pending.state) target.searchParams.set("state", pending.state);
      return res.redirect(302, target.toString());
    }
    const picked = ([] as string[]).concat(body.workspace ?? []).filter((v) => typeof v === "string");
    const { rows } = await ctx.pool.query(`select id from workspaces where id = any($1::text[])`, [picked]);
    let scope: string[];
    try {
      scope = parseStoredScope(rows.map((w) => w.id as string));
    } catch {
      return errorPage(res, 400, "Unknown workspace selection.");
    }
    const code = await provider.issueAuthorizationCode(pending, scope, session.email);
    target.searchParams.set("code", code);
    if (pending.state) target.searchParams.set("state", pending.state);
    res.redirect(302, target.toString());
  });

  return r;
}
