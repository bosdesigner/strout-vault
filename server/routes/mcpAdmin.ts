// Owner-only: personal access tokens, connected OAuth apps, the MCP audit log, and the
// embedding / server status shown on the Agents & API page.
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { createApiToken, listApiTokens, revokeApiToken } from "../mcp/auth/tokens.ts";
import { listOAuthClients, revokeOAuthClient } from "../mcp/auth/oauth.ts";
import { listAudit } from "../mcp/audit.ts";
import { parseStoredScope, RESTRICTED_WORKSPACES, UNASSIGNED } from "../mcp/scope.ts";
import { embeddingStatus } from "../embeddings/pipeline.ts";
import { TOOLS } from "../mcp/tools/index.ts";
import { HttpError, intId, parse, wrap } from "./util.ts";

const scopeSchema = z.array(z.string().max(100)).max(50);

export function mcpAdminRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    "/status",
    wrap(async (_req, res) => {
      const m = ctx.mcp;
      const [embeddings, counts] = await Promise.all([
        embeddingStatus(ctx.pool),
        ctx.pool.query(
          `select (select count(*)::int from api_tokens where revoked_at is null) as tokens,
                  (select count(*)::int from oauth_clients where revoked_at is null) as clients,
                  (select count(*)::int from mcp_audit where created_at > now() - interval '24 hours') as calls_24h,
                  (select count(*)::int from mcp_audit where created_at > now() - interval '24 hours' and error is not null) as errors_24h,
                  (select count(*)::int from interactions where workspace_id is null) as unassigned`,
        ),
      ]);
      res.json({
        enabled: m?.enabled ?? false,
        disabledReason: m?.disabledReason ?? null,
        endpoint: m?.endpoint ?? null,
        oauthEnabled: m?.oauthEnabled ?? false,
        issuer: m?.issuer ?? null,
        rolesConfigured: m?.rolesConfigured ?? { reader: false, proposer: false },
        embeddingProvider: m?.embeddings ? { name: m.embeddings.name, model: m.embeddings.model } : null,
        embeddingsError: m?.embeddingsError ?? null,
        rateLimitPerMin: ctx.config.MCP_RATE_LIMIT_PER_MIN,
        restrictedWorkspaces: RESTRICTED_WORKSPACES,
        unassignedScope: UNASSIGNED,
        unassignedRecordings: counts.rows[0].unassigned,
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, readOnly: t.readOnly })),
        embeddings,
        counts: counts.rows[0],
      });
    }),
  );

  // ---- personal access tokens
  r.get(
    "/tokens",
    wrap(async (_req, res) => {
      res.json({ items: await listApiTokens(ctx.pool) });
    }),
  );
  r.post(
    "/tokens",
    wrap(async (req, res) => {
      const body = parse(z.object({ name: z.string().trim().min(1).max(100), workspaceScope: scopeSchema, expiresInDays: z.coerce.number().int().min(1).max(3650).nullable().optional() }), req.body);
      let scope: string[];
      try {
        scope = parseStoredScope(body.workspaceScope);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const explicit = scope.filter((s) => s !== "*" && s !== UNASSIGNED);
      if (explicit.length) {
        const { rows } = await ctx.pool.query(`select id from workspaces where id = any($1::text[])`, [explicit]);
        const known = new Set(rows.map((w) => w.id as string));
        const unknown = explicit.filter((id) => !known.has(id));
        if (unknown.length) throw new HttpError(400, `unknown workspace: ${unknown.join(", ")}`);
      }
      const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null;
      const out = await createApiToken(ctx.pool, { name: body.name, workspaceScope: scope, createdBy: req.session?.email ?? null, expiresAt });
      res.status(201).json({ token: out.token, item: out.row });
    }),
  );
  r.post(
    "/tokens/:id/revoke",
    wrap(async (req, res) => {
      const row = await revokeApiToken(ctx.pool, intId(req.params.id));
      if (!row) throw new HttpError(404, "token not found");
      res.json(row);
    }),
  );

  // ---- connected OAuth apps
  r.get(
    "/clients",
    wrap(async (_req, res) => {
      res.json({ items: await listOAuthClients(ctx.pool) });
    }),
  );
  r.post(
    "/clients/:id/revoke",
    wrap(async (req, res) => {
      const id = String(req.params.id ?? "").slice(0, 200);
      if (!(await revokeOAuthClient(ctx.pool, id))) throw new HttpError(404, "client not found");
      const items = await listOAuthClients(ctx.pool);
      res.json(items.find((c) => c.clientId === id) ?? { clientId: id, revokedAt: new Date().toISOString() });
    }),
  );

  // ---- audit log
  r.get(
    "/audit",
    wrap(async (req, res) => {
      const q = parse(z.object({ token: z.string().max(60).optional(), tool: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), req.query);
      res.json({ items: await listAudit(ctx.pool, { tokenId: q.token, tool: q.tool, limit: q.limit ?? 500 }) });
    }),
  );

  return r;
}
