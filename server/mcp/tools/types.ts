import type pg from "pg";
import type { z } from "zod";
import type { EmbeddingProvider } from "../../embeddings/provider.ts";
import type { ResolvedScope } from "../scope.ts";
import type { McpPrincipal } from "../auth/principal.ts";

/** Everything a tool run needs. Built per call by the server from the bearer token. */
export interface ToolContext {
  /** SELECT-only connection (role mcp_reader). */
  reader: pg.Pool;
  /** INSERT-into-review_queue-only connection (role mcp_proposer). */
  proposer: pg.Pool;
  scope: ResolvedScope;
  principal: McpPrincipal;
  /** Origin for deep links, e.g. https://strout-vault.replit.app (no trailing slash). */
  publicUrl: string;
  embeddings: EmbeddingProvider | null;
  now: () => Date;
  /**
   * The app's own connection, used only by propose_update to run the auto-apply rules on the row it
   * just queued (services/autoApply.ts). null keeps every proposal queued.
   */
  autoApply?: { pool: pg.Pool; enabled: boolean; minConfidence: number } | null;
}

export interface ToolOutput {
  result: Record<string, unknown>;
  /** How many primary items came back, for the audit log. */
  count: number;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  readOnly: boolean;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolOutput>;
}

/** A tool-level error the agent should see as data (isError result), not a transport failure. */
export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

export function deepLink(ctx: ToolContext, path: string): string {
  return `${ctx.publicUrl.replace(/\/$/, "")}${path}`;
}

export const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
export const dateOnly = (d: unknown): string | null => (d ? String(d).slice(0, 10) : null);
