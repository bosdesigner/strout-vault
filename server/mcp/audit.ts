// Every MCP tool call lands in mcp_audit: who (token), what (tool + redacted args), the
// workspace scope in force, how many results, how long, and the error if any.
import type pg from "pg";
import type { McpPrincipal } from "./auth/principal.ts";

const SECRET_KEY = /secret|token|password|authorization|api[_-]?key/i;
const MAX_STRING = 300;

/** Long strings are cut, secret-looking keys dropped, nesting capped: the log is for review, not replay. */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[…]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactArgs(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) out[k] = "[redacted]";
      else out[k] = redactArgs(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  principal: McpPrincipal;
  tool: string;
  args: unknown;
  workspaceScope: string[];
  resultCount: number | null;
  durationMs: number;
  error: string | null;
}

export async function writeAudit(pool: pg.Pool, e: AuditEntry): Promise<void> {
  await pool.query(
    `insert into mcp_audit (token_id, client_name, tool, args, workspace_scope, result_count, duration_ms, error) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [e.principal.tokenId, e.principal.label, e.tool, JSON.stringify(redactArgs(e.args) ?? {}), JSON.stringify(e.workspaceScope), e.resultCount, e.durationMs, e.error ? e.error.slice(0, 1000) : null],
  );
}

export interface AuditFilters {
  tokenId?: string | null;
  tool?: string | null;
  limit?: number;
}

export async function listAudit(pool: pg.Pool, f: AuditFilters = {}) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.tokenId) where.push(`a.token_id = ${p(f.tokenId)}`);
  if (f.tool) where.push(`a.tool = ${p(f.tool)}`);
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 500);
  const { rows } = await pool.query(
    `select a.* from mcp_audit a ${where.length ? "where " + where.join(" and ") : ""} order by a.created_at desc, a.id desc limit ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id as number,
    tokenId: r.token_id as string,
    clientName: (r.client_name as string | null) ?? null,
    tool: r.tool as string,
    args: r.args ?? {},
    workspaceScope: (r.workspace_scope as string[] | null) ?? [],
    resultCount: (r.result_count as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
