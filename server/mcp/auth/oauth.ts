// OAuth 2.1 authorization server for Claude.ai custom connectors, on top of the MCP SDK's
// auth router: dynamic client registration, PKCE (verified by the SDK's token handler),
// hashed codes and tokens, 1-hour access tokens, refresh tokens that rotate on every use
// (a replayed refresh token revokes its whole grant). The consent screen (consent.ts) is
// where the owner signs in with the app's normal password and picks the workspaces.
import crypto from "node:crypto";
import type pg from "pg";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { parseStoredScope, type StoredScope } from "../scope.ts";
import { hashToken, PAT_PREFIX, verifyPat } from "./tokens.ts";
import type { McpPrincipal } from "./principal.ts";

export const OAUTH_SCOPES = ["vault:read", "vault:propose"] as const;

export interface OAuthOptions {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  codeTtlSec: number;
  /** Signs the pending authorization request that travels to the consent page. */
  secret: string;
  publicUrl: string;
}

/** The authorization request as it travels to the consent page (signed, short-lived). */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  exp: number;
}

export function signPending(p: PendingAuthorization, secret: string): string {
  const payload = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPending(token: string | undefined, secret: string): PendingAuthorization | null {
  if (!token || typeof token !== "string" || token.length > 4000) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PendingAuthorization;
    if (!p || typeof p.clientId !== "string" || typeof p.redirectUri !== "string" || typeof p.codeChallenge !== "string") return null;
    if (typeof p.exp !== "number" || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

function clientFromRow(r: Record<string, unknown>): OAuthClientInformationFull {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    ...(meta as object),
    client_id: r.client_id as string,
    client_secret: (r.client_secret as string | null) ?? undefined,
    client_id_issued_at: Math.floor(new Date(r.created_at as string).getTime() / 1000),
    client_secret_expires_at: r.client_secret_expires_at ? Math.floor(new Date(r.client_secret_expires_at as string).getTime() / 1000) : r.client_secret ? 0 : undefined,
    client_name: (r.client_name as string | null) ?? undefined,
    redirect_uris: (r.redirect_uris as string[]) ?? [],
  } as OAuthClientInformationFull;
}

class PgClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly pool: pg.Pool) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.pool.query(`select * from oauth_clients where client_id = $1 and revoked_at is null`, [clientId]);
    return rows[0] ? clientFromRow(rows[0]) : undefined;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & { client_id?: string }): Promise<OAuthClientInformationFull> {
    const clientId = client.client_id ?? crypto.randomUUID();
    const { client_secret, client_secret_expires_at, redirect_uris, client_name, ...rest } = client as Record<string, unknown> & { redirect_uris: string[] };
    const expires = typeof client_secret_expires_at === "number" && client_secret_expires_at > 0 ? new Date(client_secret_expires_at * 1000) : null;
    await this.pool.query(
      `insert into oauth_clients (client_id, client_secret, client_secret_expires_at, client_name, redirect_uris, metadata) values ($1, $2, $3, $4, $5::text[], $6::jsonb)`,
      [clientId, (client_secret as string | undefined) ?? null, expires, (client_name as string | undefined) ?? null, redirect_uris ?? [], JSON.stringify({ ...rest, redirect_uris, client_name })],
    );
    const { rows } = await this.pool.query(`select * from oauth_clients where client_id = $1`, [clientId]);
    return clientFromRow(rows[0]);
  }
}

export interface IssuedTokens extends OAuthTokens {
  refresh_token: string;
}

export class VaultOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PgClientsStore;
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: OAuthOptions,
  ) {
    this.clientsStore = new PgClientsStore(pool);
  }

  /** Step 1: the SDK validated client + redirect_uri; send the browser to our consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      exp: Math.floor(Date.now() / 1000) + 10 * 60,
    };
    const url = new URL("/oauth/consent", this.opts.publicUrl || "http://localhost");
    url.searchParams.set("req", signPending(pending, this.opts.secret));
    res.redirect(302, this.opts.publicUrl ? url.toString() : `${url.pathname}${url.search}`);
  }

  /** Step 2 (from the consent page): the owner approved; mint the authorization code. */
  async issueAuthorizationCode(p: PendingAuthorization, workspaceScope: StoredScope, email: string): Promise<string> {
    const code = crypto.randomBytes(32).toString("base64url");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into oauth_codes (code_hash, client_id, code_challenge, redirect_uri, scopes, workspace_scope, resource, user_email, expires_at)
         values ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, $8, now() + ($9 || ' seconds')::interval)`,
        [hashToken(code), p.clientId, p.codeChallenge, p.redirectUri, p.scopes, JSON.stringify(workspaceScope), p.resource ?? null, email, String(this.opts.codeTtlSec)],
      );
      await client.query(`update oauth_clients set workspace_scope = $2::jsonb, consented_by = $3, consented_at = now() where client_id = $1`, [p.clientId, JSON.stringify(workspaceScope), email]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const { rows } = await this.pool.query(
      `select code_challenge from oauth_codes where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now()`,
      [hashToken(authorizationCode), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError("unknown, used or expired authorization code");
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      const { rows } = await db.query(
        `select * from oauth_codes where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now() for update`,
        [hashToken(authorizationCode), client.client_id],
      );
      const code = rows[0];
      if (!code) throw new InvalidGrantError("unknown, used or expired authorization code");
      if (redirectUri && redirectUri !== code.redirect_uri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
      if (resource && code.resource && resource.href !== code.resource) throw new InvalidGrantError("resource does not match the authorization request");
      await db.query(`update oauth_codes set used_at = now() where code_hash = $1`, [code.code_hash]);
      const tokens = await this.issueTokens(db, {
        clientId: client.client_id,
        grantId: crypto.randomUUID(),
        scopes: code.scopes as string[],
        workspaceScope: parseStoredScope(code.workspace_scope),
        resource: (code.resource as string | null) ?? null,
        email: code.user_email as string,
      });
      await db.query("commit");
      return tokens;
    } catch (err) {
      await db.query("rollback").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      const { rows } = await db.query(`select * from oauth_tokens where token_hash = $1 and kind = 'refresh' and client_id = $2 for update`, [hashToken(refreshToken), client.client_id]);
      const old = rows[0];
      if (!old) throw new InvalidGrantError("unknown refresh token");
      if (old.revoked_at || old.replaced_by) {
        // A rotated refresh token came back: someone replayed it. Kill the whole grant.
        await db.query(`update oauth_tokens set revoked_at = coalesce(revoked_at, now()) where grant_id = $1`, [old.grant_id]);
        await db.query("commit");
        throw new InvalidGrantError("refresh token was already used; the grant has been revoked");
      }
      if (new Date(old.expires_at).getTime() < Date.now()) throw new InvalidGrantError("refresh token has expired");
      const granted = old.scopes as string[];
      if (scopes?.some((s) => !granted.includes(s))) throw new InvalidRequestError("requested scope exceeds the grant");
      if (resource && old.resource && resource.href !== old.resource) throw new InvalidGrantError("resource does not match the grant");
      const tokens = await this.issueTokens(db, {
        clientId: client.client_id,
        grantId: old.grant_id as string,
        scopes: scopes?.length ? scopes : granted,
        workspaceScope: parseStoredScope(old.workspace_scope),
        resource: (old.resource as string | null) ?? null,
        email: old.user_email as string,
        replaces: old.id as number,
      });
      await db.query("commit");
      return tokens;
    } catch (err) {
      await db.query("rollback").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  private async issueTokens(
    db: pg.PoolClient,
    g: { clientId: string; grantId: string; scopes: string[]; workspaceScope: StoredScope; resource: string | null; email: string; replaces?: number },
  ): Promise<IssuedTokens> {
    const access = crypto.randomBytes(32).toString("base64url");
    const refresh = crypto.randomBytes(32).toString("base64url");
    const insert = async (kind: "access" | "refresh", token: string, ttl: number) => {
      const { rows } = await db.query(
        `insert into oauth_tokens (token_hash, kind, client_id, grant_id, scopes, workspace_scope, resource, user_email, expires_at)
         values ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, $8, now() + ($9 || ' seconds')::interval) returning id`,
        [hashToken(token), kind, g.clientId, g.grantId, g.scopes, JSON.stringify(g.workspaceScope), g.resource, g.email, String(ttl)],
      );
      return rows[0].id as number;
    };
    await insert("access", access, this.opts.accessTokenTtlSec);
    const refreshId = await insert("refresh", refresh, this.opts.refreshTokenTtlSec);
    if (g.replaces) await db.query(`update oauth_tokens set revoked_at = now(), replaced_by = $2 where id = $1`, [g.replaces, refreshId]);
    await db.query(`update oauth_clients set last_used_at = now() where client_id = $1`, [g.clientId]);
    return { access_token: access, token_type: "bearer", expires_in: this.opts.accessTokenTtlSec, refresh_token: refresh, scope: g.scopes.join(" ") };
  }

  /** Bearer verification for both token kinds: personal tokens (svt_...) and OAuth access tokens. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith(PAT_PREFIX)) {
      const pat = await verifyPat(this.pool, token);
      if (!pat) throw new InvalidTokenError("unknown, revoked or expired token");
      return {
        token,
        clientId: "personal-access-token",
        scopes: pat.scopes,
        // The SDK insists on an expiry; a non-expiring personal token is reported as far in the future.
        expiresAt: pat.expiresAt ?? Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        extra: { principal: pat.principal },
      };
    }
    const { rows } = await this.pool.query(
      `select t.id, t.client_id, t.scopes, t.workspace_scope, t.user_email, t.expires_at, t.resource, c.client_name
         from oauth_tokens t join oauth_clients c on c.client_id = t.client_id
        where t.token_hash = $1 and t.kind = 'access' and t.revoked_at is null and c.revoked_at is null`,
      [hashToken(token)],
    );
    const r = rows[0];
    if (!r) throw new InvalidTokenError("unknown or revoked token");
    if (new Date(r.expires_at).getTime() < Date.now()) throw new InvalidTokenError("token has expired");
    void this.pool.query(`update oauth_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.id]).catch(() => {});
    const principal: McpPrincipal = {
      kind: "oauth",
      tokenId: `oauth:${r.id}`,
      label: r.client_name ?? r.client_id,
      scope: parseStoredScope(r.workspace_scope),
      email: r.user_email,
      clientId: r.client_id,
    };
    return {
      token,
      clientId: r.client_id,
      scopes: r.scopes as string[],
      expiresAt: Math.floor(new Date(r.expires_at).getTime() / 1000),
      resource: r.resource ? new URL(r.resource) : undefined,
      extra: { principal },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.pool.query(`update oauth_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = $1 and client_id = $2`, [hashToken(request.token), client.client_id]);
  }
}

/** Connected-apps page: clients with their scope and token activity. */
export async function listOAuthClients(pool: pg.Pool) {
  const { rows } = await pool.query(
    `select c.client_id, c.client_name, c.redirect_uris, c.workspace_scope, c.consented_by, c.consented_at, c.created_at, c.last_used_at, c.revoked_at,
            (select count(*)::int from oauth_tokens t where t.client_id = c.client_id and t.kind = 'refresh' and t.revoked_at is null and t.expires_at > now()) as active_grants,
            (select count(*) from mcp_audit a join oauth_tokens t on 'oauth:' || t.id = a.token_id where t.client_id = c.client_id) as calls
       from oauth_clients c order by c.revoked_at is not null, c.created_at desc`,
  );
  return rows.map((r) => ({
    clientId: r.client_id as string,
    clientName: (r.client_name as string | null) ?? null,
    redirectUris: (r.redirect_uris as string[]) ?? [],
    workspaceScope: parseStoredScope(r.workspace_scope),
    consentedBy: (r.consented_by as string | null) ?? null,
    consentedAt: r.consented_at ? new Date(r.consented_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    activeGrants: r.active_grants as number,
    calls: Number(r.calls ?? 0),
  }));
}

/** Revokes a client and every token it holds. */
export async function revokeOAuthClient(pool: pg.Pool, clientId: string): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const r = await db.query(`update oauth_clients set revoked_at = coalesce(revoked_at, now()) where client_id = $1`, [clientId]);
    await db.query(`update oauth_tokens set revoked_at = coalesce(revoked_at, now()) where client_id = $1`, [clientId]);
    await db.query("commit");
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
