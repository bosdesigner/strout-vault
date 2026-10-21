// Swappable authentication. Phase 1 ships a single admin login from env vars;
// Phase 3 adds contractor logins (memberships + magic links) as another provider.

export interface Principal {
  /** Stable subject id. "admin" for the env-configured owner. */
  sub: string;
  email: string;
  role: "owner" | "contractor";
  /** Set when a login is scoped to one workspace (Phase 3). */
  workspaceId?: string | null;
  partyId?: number | null;
}

export interface AuthProvider {
  readonly name: string;
  /** Returns the principal for a correct email + password, or null. Must take constant-ish time on failure. */
  verifyPassword(email: string, password: string): Promise<Principal | null>;
}

export interface SessionData extends Principal {
  /** Synchroniser token checked on every state-changing request. */
  csrf: string;
  /** Unix seconds. */
  exp: number;
}
