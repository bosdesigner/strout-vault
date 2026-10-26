// Owner-only: connecting Gmail accounts (OAuth, scope gmail.readonly and nothing else) and
// seeing their sync state. The refresh token is encrypted before it is stored and never sent
// back to the browser. Nothing here sends, labels or changes mail.
import crypto from "node:crypto";
import { Router } from "express";
import type { AppContext } from "../context.ts";
import { encryptSecret } from "../messages/crypto.ts";
import { exchangeCode, GMAIL_READONLY_SCOPE, GmailClient } from "../messages/gmail/api.ts";
import { gmailConfigured } from "../messages/gmail/sync.ts";
import { HttpError, intId, wrap } from "./util.ts";

const STATE_TTL_MS = 10 * 60_000;

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`gmail-connect:${payload}`).digest("base64url");
}

export function makeState(secret: string, email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + STATE_TTL_MS, n: crypto.randomBytes(8).toString("hex") })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function checkState(secret: string, state: string, email: string, now = Date.now()): boolean {
  const [payload, mac] = state.split(".");
  if (!payload || !mac) return false;
  const expected = sign(secret, payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { e: string; x: number };
    return v.e === email && v.x > now;
  } catch {
    return false;
  }
}

export function messagesRouter(ctx: AppContext): Router {
  const r = Router();
  const c = ctx.config;
  const redirectUri = () => `${c.PUBLIC_URL.replace(/\/$/, "")}/api/messages/gmail/callback`;

  r.get(
    "/accounts",
    wrap(async (_req, res) => {
      const { rows } = await ctx.pool.query(
        `select id, provider, account_email, scope, history_id is not null as syncing, status, last_synced_at, last_error, created_at from message_accounts order by id`,
      );
      const runs = await ctx.pool.query(`select source, counts_out, finished_at from import_runs where source in ('gmail', 'imessage') order by id desc limit 10`);
      res.json({ configured: gmailConfigured(c), items: rows, recentRuns: runs.rows });
    }),
  );

  r.get(
    "/gmail/connect",
    wrap(async (req, res) => {
      if (!gmailConfigured(c)) throw new HttpError(503, "Gmail is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MESSAGES_ENCRYPTION_KEY");
      if (!c.PUBLIC_URL) throw new HttpError(503, "PUBLIC_URL is not set");
      const url = new URL(c.GOOGLE_OAUTH_AUTHORIZE_URL);
      url.searchParams.set("client_id", c.GOOGLE_CLIENT_ID!);
      url.searchParams.set("redirect_uri", redirectUri());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GMAIL_READONLY_SCOPE);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("state", makeState(c.SESSION_SECRET, req.session!.email));
      res.redirect(url.toString());
    }),
  );

  r.get(
    "/gmail/callback",
    wrap(async (req, res) => {
      if (!gmailConfigured(c)) throw new HttpError(503, "Gmail is not configured");
      const state = String(req.query.state ?? "");
      if (!checkState(c.SESSION_SECRET, state, req.session!.email)) throw new HttpError(400, "invalid or expired state; start again from /api/messages/gmail/connect");
      if (req.query.error) throw new HttpError(400, `Google returned ${String(req.query.error).slice(0, 60)}`);
      const code = String(req.query.code ?? "");
      if (!code) throw new HttpError(400, "missing code");
      const tokens = await exchangeCode({ tokenUrl: c.GOOGLE_OAUTH_TOKEN_URL, clientId: c.GOOGLE_CLIENT_ID!, clientSecret: c.GOOGLE_CLIENT_SECRET!, redirectUri: redirectUri(), code, fetchImpl: ctx.fetchImpl });
      const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
      if (granted.some((s) => s !== GMAIL_READONLY_SCOPE)) throw new HttpError(400, `Google granted more than gmail.readonly (${granted.join(" ")}); refusing to store it`);
      if (!tokens.refresh_token) throw new HttpError(400, "Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and connect again");
      const client = new GmailClient({
        apiBase: c.GMAIL_API_BASE,
        tokenUrl: c.GOOGLE_OAUTH_TOKEN_URL,
        clientId: c.GOOGLE_CLIENT_ID!,
        clientSecret: c.GOOGLE_CLIENT_SECRET!,
        refreshToken: tokens.refresh_token,
        fetchImpl: ctx.fetchImpl,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      });
      const profile = await client.profile();
      const email = profile.emailAddress.toLowerCase();
      await ctx.pool.query(
        `insert into message_accounts (provider, account_email, refresh_token_enc, scope, status, created_by)
         values ('gmail', $1, $2, $3, 'active', $4)
         on conflict (provider, account_email) do update set refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope, status = 'active', last_error = null, updated_at = now()`,
        [email, encryptSecret(tokens.refresh_token, c.MESSAGES_ENCRYPTION_KEY), granted.join(" ") || GMAIL_READONLY_SCOPE, req.session!.email],
      );
      res.type("text").send(`Connected ${email} (read-only). The worker starts syncing new mail on its next run; run a backfill with: npm run messages:gmail -- --account ${email} --since 30 --dry-run`);
    }),
  );

  r.post(
    "/accounts/:id/disable",
    wrap(async (req, res) => {
      const { rowCount } = await ctx.pool.query(`update message_accounts set status = 'disabled', updated_at = now() where id = $1`, [intId(req.params.id)]);
      if (!rowCount) throw new HttpError(404, "account not found");
      res.json({ ok: true });
    }),
  );

  return r;
}
