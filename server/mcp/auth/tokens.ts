// Personal access tokens for Claude Code and scheduled jobs. Created on the Agents page,
// shown once, stored as a SHA-256 hash, revocable, workspace-scoped. Sent as
// `Authorization: Bearer svt_...`.
import crypto from "node:crypto";
import type pg from "pg";
import { parseStoredScope, type StoredScope } from "../scope.ts";
import type { McpPrincipal } from "./principal.ts";

export const PAT_PREFIX = "svt_";

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
  input: { name: string; workspaceScope: StoredScope; createdBy: string | null; expiresAt?: Date | null },
): Promise<{ token: string; row: ApiTokenRow }> {
  const scope = parseStoredScope(input.workspaceScope);
  const gen = generatePat();
  const { rows } = await pool.query(
    `insert into api_tokens (name, token_hash, token_prefix, workspace_scope, created_by, expires_at) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
    [input.name.trim(), gen.hash, gen.prefix, JSON.stringify(scope), input.createdBy, input.expiresAt ?? null],
  );
  const out = await pool.query(`${SELECT} where t.id = $1`, [rows[0].id]);
  return { token: gen.token, row: row(out.rows[0]) };
}

export async function revokeApiToken(pool: pg.Pool, id: number): Promise<ApiTokenRow | null> {
  await pool.query(`update api_tokens set revoked_at = coalesce(revoked_at, now()) where id = $1`, [id]);
  const out = await pool.query(`${SELECT} where t.id = $1`, [id]);
  return out.rows[0] ? row(out.rows[0]) : null;
}

/** Null when the token is unknown, revoked or expired. Stamps last_used_at at most once a minute. */
export async function verifyPat(pool: pg.Pool, token: string): Promise<{ principal: McpPrincipal; expiresAt: number | null } | null> {
  const { rows } = await pool.query(
    `select id, name, workspace_scope, created_by, expires_at from api_tokens
      where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  void pool
    .query(`update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.id])
    .catch(() => {});
  return {
    principal: { kind: "pat", tokenId: `pat:${r.id}`, label: r.name, scope: parseStoredScope(r.workspace_scope), email: r.created_by ?? null, clientId: null },
    expiresAt: r.expires_at ? Math.floor(new Date(r.expires_at).getTime() / 1000) : null,
  };
}
