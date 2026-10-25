import type { StoredScope } from "../scope.ts";

/** Who is calling a tool, as carried in AuthInfo.extra from the bearer middleware to the tool. */
export interface McpPrincipal {
  kind: "pat" | "oauth";
  /** "pat:<api_tokens.id>" or "oauth:<oauth_tokens.id>"; the mcp_audit.token_id value. */
  tokenId: string;
  /** The token's name, or the OAuth client's name. */
  label: string;
  scope: StoredScope;
  email: string | null;
  clientId: string | null;
}

export function principalFromAuthInfo(extra: Record<string, unknown> | undefined): McpPrincipal | null {
  const p = extra?.principal as McpPrincipal | undefined;
  if (!p || typeof p.tokenId !== "string" || !Array.isArray(p.scope)) return null;
  return p;
}
