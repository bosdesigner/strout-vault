// Swappable authentication. Phase 1 ships a single admin login from env vars;
// Phase 3 adds contractor logins (memberships + magic links) as another provider.

export interface Principal {
  /** Stable subject id. "admin" for the env-configured owner, "m:<id>" for a membership. */
  sub: string;
  email: string;
  role: "owner" | "contractor";
  /** Set when a login is scoped to one workspace (contractors). */
  workspaceId?: string | null;
  /** The login's own party row, when known. */
  partyId?: number | null;
  membershipId?: number | null;
  displayName?: string | null;
}

export interface AuthProvider {
  readonly name: string;
  /** Returns the principal for a correct email + password, or null. Must take constant-ish time on failure. */
  verifyPassword(email: string, password: string): Promise<Principal | null>;
  /**
   * Emails a single-use sign-in link when the address belongs to an active or
   * invited membership. Always resolves (never reveals whether the address exists).
   */
  requestMagicLink(email: string, meta: { ip?: string | null; baseUrl: string }): Promise<void>;
  /** Redeems a magic-link token once. Null when unknown, used or expired. */
  redeemMagicLink(token: string): Promise<Principal | null>;
}

export interface SessionData extends Principal {
  /** Synchroniser token checked on every state-changing request. */
  csrf: string;
  /** Unix seconds. */
  exp: number;
}
