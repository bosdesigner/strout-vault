import crypto from "node:crypto";
import type pg from "pg";
import type { AuthProvider, Principal } from "./types.ts";
import type { Mailer } from "../mail/types.ts";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Contractor logins: memberships + single-use magic links. Tokens are 32
 * random bytes, stored only as a SHA-256 hash, valid for `ttlMin` minutes.
 */
export class MembershipAuthProvider implements AuthProvider {
  readonly name = "membership-magic-link";
  constructor(
    private readonly pool: pg.Pool,
    private readonly mailer: Mailer,
    private readonly opts: { ttlMin: number; appName?: string },
  ) {}

  async verifyPassword(): Promise<Principal | null> {
    return null; // contractors have no password
  }

  async requestMagicLink(email: string, meta: { ip?: string | null; baseUrl: string }): Promise<void> {
    const { rows } = await this.pool.query(
      `select id, email, status from memberships where lower(email) = lower($1) and status in ('invited', 'active') order by id limit 1`,
      [email.trim()],
    );
    const m = rows[0];
    if (!m) return; // do not reveal whether the address is known
    const token = crypto.randomBytes(32).toString("base64url");
    await this.pool.query(
      `insert into login_tokens (membership_id, token_hash, expires_at, requested_ip) values ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
      [m.id, hashToken(token), String(this.opts.ttlMin), meta.ip ?? null],
    );
    const link = `${meta.baseUrl.replace(/\/$/, "")}/api/auth/magic?token=${encodeURIComponent(token)}`;
    const app = this.opts.appName ?? "Strout Vault";
    await this.mailer.send({
      to: m.email,
      subject: `Your ${app} sign-in link`,
      text: `Sign in to ${app}:\n\n${link}\n\nThe link works once and expires in ${this.opts.ttlMin} minutes. If you did not ask for it, ignore this email.`,
      html: `<p>Sign in to ${app}:</p><p><a href="${link}">${link}</a></p><p>The link works once and expires in ${this.opts.ttlMin} minutes. If you did not ask for it, ignore this email.</p>`,
    });
  }

  async redeemMagicLink(token: string): Promise<Principal | null> {
    if (!token || token.length > 200) return null;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `select t.id as token_id, m.* from login_tokens t join memberships m on m.id = t.membership_id
         where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and m.status in ('invited', 'active')
         for update of t`,
        [hashToken(token)],
      );
      const m = rows[0];
      if (!m) {
        await client.query("rollback");
        return null;
      }
      await client.query(`update login_tokens set used_at = now() where id = $1`, [m.token_id]);
      await client.query(`update memberships set status = 'active', last_login_at = now() where id = $1`, [m.id]);
      await client.query("commit");
      return principalFor(m);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

export function principalFor(m: { id: number; email: string; role: string; workspace_id: string | null; party_id: number | null; display_name: string | null }): Principal {
  return {
    sub: `m:${m.id}`,
    email: m.email,
    role: m.role === "owner" ? "owner" : "contractor",
    workspaceId: m.role === "owner" ? null : m.workspace_id,
    partyId: m.party_id,
    membershipId: m.id,
    displayName: m.display_name,
  };
}

/** Tries each provider in order: the env owner (password) and memberships (magic links). */
export class CompositeAuthProvider implements AuthProvider {
  readonly name = "composite";
  constructor(private readonly providers: AuthProvider[]) {}

  async verifyPassword(email: string, password: string): Promise<Principal | null> {
    for (const p of this.providers) {
      const out = await p.verifyPassword(email, password);
      if (out) return out;
    }
    return null;
  }

  async requestMagicLink(email: string, meta: { ip?: string | null; baseUrl: string }): Promise<void> {
    for (const p of this.providers) await p.requestMagicLink(email, meta);
  }

  async redeemMagicLink(token: string): Promise<Principal | null> {
    for (const p of this.providers) {
      const out = await p.redeemMagicLink(token);
      if (out) return out;
    }
    return null;
  }
}
