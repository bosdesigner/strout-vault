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
 * /api/ingest/messages and nothing else, so it is never combined with the others and carries no
 * workspace scope.
 */
export const TOKEN_SCOPES = ["vault:read", "vault:propose", "ingest:messages"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const MCP_TOKEN_SCOPES: TokenScope[] = ["vault:read", "vault:propose"];
export const INGEST_MESSAGES_SCOPE: TokenScope = "ingest:messages";

export function parseTokenScopes(value: unknown): TokenScope[] {
  if (value == null) return [...MCP_TOKEN_SCOPES];
  if (!Array.isArray(value) || !value.length) throw new Error("token scopes must be a non-empty array");
  const out: TokenScope[] = [];
  for (const v of value) {
    if (!(TOKEN_SCOPES as readonly string[]).includes(v as string)) throw new Error(`unknown token scope: ${String(v).slice(0, 40)}`);
    if (!out.includes(v as TokenScope)) out.push(v as TokenScope);
  }
  if (out.includes(INGEST_MESSAGES_SCOPE) && out.length > 1) throw new Error("ingest:messages cannot be combined with other scopes");
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
  input: { name: string; workspaceScope: StoredScope; scopes?: TokenScope[]; createdBy: string | null; expiresAt?: Date | null },
): Promise<{ token: string; row: ApiTokenRow }> {
  const scopes = parseTokenScopes(input.scopes);
  // An ingest token reads nothing: whatever workspace scope was sent, it gets none.
  const scope = scopes.includes(INGEST_MESSAGES_SCOPE) ? [] : parseStoredScope(input.workspaceScope);
  const gen = generatePat();
  const { rows } = await pool.query(
    `insert into api_tokens (name, token_hash, token_prefix, workspace_scope, scopes, created_by, expires_at) values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning id`,
    [input.name.trim(), gen.hash, gen.prefix, JSON.stringify(scope), scopes, input.createdBy, input.expiresAt ?? null],
  );
  const out = await pool.query(`${SELECT} where t.id = $1`, [rows[0].id]);
  return { token: gen.token, row: row(out.rows[0]) };
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
  const scopes = ((r.scopes as TokenScope[] | null) ?? [...MCP_TOKEN_SCOPES]).filter((s) => s !== INGEST_MESSAGES_SCOPE);
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

/** POST /api/ingest/messages's check: the token must be live and carry ingest:messages. */
export async function verifyIngestToken(pool: pg.Pool, token: string): Promise<{ id: number; name: string } | "forbidden" | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const { rows } = await pool.query(
    `select id, name, scopes from api_tokens where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!((r.scopes as string[] | null) ?? []).includes(INGEST_MESSAGES_SCOPE)) return "forbidden";
  void pool
    .query(`update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.id])
    .catch(() => {});
  return { id: Number(r.id), name: r.name as string };
}
