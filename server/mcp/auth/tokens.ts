// Personal access tokens for Claude Code and scheduled jobs. Created on the Agents page,
// shown once, stored as a SHA-256 hash, revocable, workspace-scoped. Sent as
// `Authorization: Bearer svt_...`.
import crypto from "node:crypto";
import type pg from "pg";
import { parseStoredScope, type StoredScope } from "../scope.ts";
import type { McpPrincipal } from "./principal.ts";

export const PAT_PREFIX = "svt_";

/**
 * What a personal access token may do. vault:read + vault:propose are the MCP server (every token
 * made before scopes existed has both). ingest:messages is the iMessage collector's: it may POST
 * /api/ingest/messages and nothing else. ingest:device is the Mac media collector's and the iPhone
 * Shortcut's: /api/ingest/device/* and nothing else. An ingest scope is never combined with any
 * other scope and carries no workspace scope.
 */
export const TOKEN_SCOPES = ["vault:read", "vault:propose", "ingest:messages", "ingest:device"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const MCP_TOKEN_SCOPES: TokenScope[] = ["vault:read", "vault:propose"];
export const INGEST_MESSAGES_SCOPE: TokenScope = "ingest:messages";
export const INGEST_DEVICE_SCOPE: TokenScope = "ingest:device";
export const INGEST_SCOPES: TokenScope[] = [INGEST_MESSAGES_SCOPE, INGEST_DEVICE_SCOPE];

/** Which collector a token was made for (api_tokens.purpose); the Sources view reads it. */
export const TOKEN_PURPOSES = ["mcp", "imessage", "social_dm", "mac_media", "ios_shortcut"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export function isIngestOnly(scopes: readonly string[]): boolean {
  return scopes.some((s) => (INGEST_SCOPES as readonly string[]).includes(s));
}

export function parseTokenScopes(value: unknown): TokenScope[] {
  if (value == null) return [...MCP_TOKEN_SCOPES];
  if (!Array.isArray(value) || !value.length) throw new Error("token scopes must be a non-empty array");
  const out: TokenScope[] = [];
  for (const v of value) {
    if (!(TOKEN_SCOPES as readonly string[]).includes(v as string)) throw new Error(`unknown token scope: ${String(v).slice(0, 40)}`);
    if (!out.includes(v as TokenScope)) out.push(v as TokenScope);
  }
  for (const ingest of INGEST_SCOPES) if (out.includes(ingest) && out.length > 1) throw new Error(`${ingest} cannot be combined with other scopes`);
  return out;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generatePat(): { token: string; hash: string; prefix: string } {
  const token = PAT_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, PAT_PREFIX.length + 6) };
}

export interface ApiTokenRow {
  id: number;
  name: string;
  tokenPrefix: string;
  workspaceScope: StoredScope;
  scopes: TokenScope[];
  createdBy: string | null;
  purpose: TokenPurpose | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  calls: number;
}

function row(r: Record<string, unknown>): ApiTokenRow {
  return {
    id: r.id as number,
    name: r.name as string,
    tokenPrefix: r.token_prefix as string,
    workspaceScope: parseStoredScope(r.workspace_scope),
    scopes: (r.scopes as TokenScope[] | null) ?? [...MCP_TOKEN_SCOPES],
    createdBy: (r.created_by as string | null) ?? null,
    purpose: (r.purpose as TokenPurpose | null | undefined) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : null,
    calls: Number(r.calls ?? 0),
  };
}

const SELECT = `select t.*, (select count(*) from mcp_audit a where a.token_id = 'pat:' || t.id) as calls from api_tokens t`;

export async function listApiTokens(pool: pg.Pool): Promise<ApiTokenRow[]> {
  const { rows } = await pool.query(`${SELECT} order by t.revoked_at is not null, t.created_at desc`);
  return rows.map(row);
}

export async function createApiToken(
  pool: pg.Pool,
  input: { name: string; workspaceScope: StoredScope; scopes?: TokenScope[]; purpose?: TokenPurpose | null; createdBy: string | null; expiresAt?: Date | null },
): Promise<{ token: string; row: ApiTokenRow }> {
  const scopes = parseTokenScopes(input.scopes);
  // An ingest token reads nothing: whatever workspace scope was sent, it gets none.
  const scope = isIngestOnly(scopes) ? [] : parseStoredScope(input.workspaceScope);
  const purpose = tokenPurpose(scopes, input.purpose ?? null);
  const gen = generatePat();
  const params = [input.name.trim(), gen.hash, gen.prefix, JSON.stringify(scope), scopes, input.createdBy, input.expiresAt ?? null];
  const { rows } = await pool
    .query(`insert into api_tokens (name, token_hash, token_prefix, workspace_scope, scopes, created_by, expires_at, purpose) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) returning id`, [...params, purpose])
    .catch(async (err: { code?: string }) => {
      // Before migration 0010 there is no purpose column: MCP and iMessage tokens still work; a device token needs 0010.
      if (err.code !== "42703" || scopes.includes(INGEST_DEVICE_SCOPE)) throw err;
      return pool.query(`insert into api_tokens (name, token_hash, token_prefix, workspace_scope, scopes, created_by, expires_at) values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning id`, params);
    });
  const out = await pool.query(`${SELECT} where t.id = $1`, [rows[0].id]);
  return { token: gen.token, row: row(out.rows[0]) };
}

/** The purpose stored for a token: it must agree with its scopes (an ingest:device token is a Mac collector or a Shortcut). */
export function tokenPurpose(scopes: TokenScope[], wanted: TokenPurpose | null): TokenPurpose {
  if (scopes.includes(INGEST_DEVICE_SCOPE)) {
    if (wanted && wanted !== "mac_media" && wanted !== "ios_shortcut") throw new Error("an ingest:device token is for the Mac media collector or the iPhone Shortcut");
    return wanted ?? "mac_media";
  }
  if (scopes.includes(INGEST_MESSAGES_SCOPE)) {
    if (wanted && wanted !== "imessage" && wanted !== "social_dm") throw new Error("an ingest:messages token is for the iMessage collector or the TikTok DM collector");
    return wanted ?? "imessage";
  }
  if (wanted && wanted !== "mcp") throw new Error(`purpose ${wanted} needs an ingest scope`);
  return "mcp";
}

export async function revokeApiToken(pool: pg.Pool, id: number): Promise<ApiTokenRow | null> {
  await pool.query(`update api_tokens set revoked_at = coalesce(revoked_at, now()) where id = $1`, [id]);
  const out = await pool.query(`${SELECT} where t.id = $1`, [id]);
  return out.rows[0] ? row(out.rows[0]) : null;
}

/**
 * The MCP server's check. Null when the token is unknown, revoked or expired, or is not an MCP
 * token (an ingest:messages token cannot call any tool). Stamps last_used_at at most once a minute.
 */
export async function verifyPat(pool: pg.Pool, token: string): Promise<{ principal: McpPrincipal; expiresAt: number | null; scopes: TokenScope[] } | null> {
  const { rows } = await pool.query(
    `select id, name, workspace_scope, scopes, created_by, expires_at from api_tokens
      where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const scopes = ((r.scopes as TokenScope[] | null) ?? [...MCP_TOKEN_SCOPES]).filter((s) => !INGEST_SCOPES.includes(s));
  if (!scopes.includes("vault:read")) return null;
  void pool
    .query(`update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.id])
    .catch(() => {});
  return {
    principal: { kind: "pat", tokenId: `pat:${r.id}`, label: r.name, scope: parseStoredScope(r.workspace_scope), email: r.created_by ?? null, clientId: null },
    expiresAt: r.expires_at ? Math.floor(new Date(r.expires_at).getTime() / 1000) : null,
    scopes,
  };
}

/**
 * The ingest endpoints' check: the token must be live and carry `scope` (ingest:messages for
 * /api/ingest/messages, ingest:device for /api/ingest/device/*). "forbidden" for a live token
 * without it (an MCP token, or the other collector's token).
 */
export async function verifyIngestToken(pool: pg.Pool, token: string, scope: TokenScope = INGEST_MESSAGES_SCOPE): Promise<{ id: number; name: string; purpose: TokenPurpose | null } | "forbidden" | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const { rows } = await pool.query(
    `select id, name, scopes, purpose from api_tokens where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!((r.scopes as string[] | null) ?? []).includes(scope)) return "forbidden";
  void pool
    .query(`update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.id])
    .catch(() => {});
  return { id: Number(r.id), name: r.name as string, purpose: (r.purpose as TokenPurpose | null) ?? null };
}
