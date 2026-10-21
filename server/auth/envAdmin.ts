import type { AuthProvider, Principal } from "./types.ts";
import { verifyPasswordHash } from "./password.ts";

// A bcrypt hash of an unguessable string, compared against when the email does
// not match so wrong-email and wrong-password attempts take the same time.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5Yv0Z1lz0q3HnqkX7sYz7aYz7aYz7aY";

export class EnvAdminAuthProvider implements AuthProvider {
  readonly name = "env-admin";
  constructor(private readonly adminEmail: string, private readonly adminPasswordHash: string) {}

  async verifyPassword(email: string, password: string): Promise<Principal | null> {
    const matchesEmail = email.trim().toLowerCase() === this.adminEmail.trim().toLowerCase();
    const ok = await verifyPasswordHash(password, matchesEmail ? this.adminPasswordHash : DUMMY_HASH);
    if (!matchesEmail || !ok) return null;
    return { sub: "admin", email: this.adminEmail, role: "owner", workspaceId: null, partyId: null, membershipId: null };
  }

  async requestMagicLink(): Promise<void> {
    /* the owner signs in with a password */
  }

  async redeemMagicLink(): Promise<Principal | null> {
    return null;
  }
}
