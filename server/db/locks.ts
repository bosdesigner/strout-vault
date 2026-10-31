// Advisory locks that cannot get stuck. A session advisory lock lives on the Postgres connection
// that took it. Through Neon's pooled endpoint (PgBouncer in transaction mode) the lock and its
// unlock can run on different server connections, so the unlock silently does nothing and the lock
// stays held by an idle pooled connection until it is recycled. Every "only one at a time" lock in
// the worker therefore takes its own direct (non-pooled) connection and closes it on release:
// closing the connection drops the lock even if the unlock query fails.
import pg from "pg";
import { needsSsl } from "./client.ts";

export interface HeldLock {
  release(): Promise<void>;
}

/** Neon's pooled host is "<endpoint>-pooler.<region>…"; the direct host is the same name without "-pooler". */
export function directUrl(url: string): string {
  return url.replace(/-pooler\./, ".");
}

function urlOf(pool: pg.Pool): string {
  const s = (pool as unknown as { options?: { connectionString?: string } }).options?.connectionString;
  if (!s) throw new Error("advisory lock: the pool has no connection string");
  return s;
}

/** pg_try_advisory_lock(hashtext(name)) on a dedicated direct connection; null when someone else holds it. */
export async function tryAdvisoryLock(pool: pg.Pool, name: string): Promise<HeldLock | null> {
  const url = directUrl(urlOf(pool));
  const client = new pg.Client({ connectionString: url, ssl: needsSsl(url) ? { rejectUnauthorized: true } : undefined, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let ok = false;
  try {
    ok = !!(await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [name])).rows[0]?.ok;
  } finally {
    if (!ok) await client.end().catch(() => {});
  }
  if (!ok) return null;
  return {
    async release() {
      await client.query(`select pg_advisory_unlock(hashtext($1))`, [name]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}
