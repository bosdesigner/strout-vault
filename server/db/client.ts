import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

// Postgres `real` and `bigint` columns: node-postgres returns bigint as a
// string to avoid precision loss. Our ids fit in a JS number, so parse them.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(700, (v) => parseFloat(v)); // float4
pg.types.setTypeParser(701, (v) => parseFloat(v)); // float8
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
// `date` columns (due_date, started_at, ended_at) stay "YYYY-MM-DD" strings instead of becoming
// local-midnight Date objects, which the API would otherwise render as "Wed May 24".
pg.types.setTypeParser(1082, (v) => v); // date

export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    // Neon idles out connections; keep ours short-lived too.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl(databaseUrl) ? { rejectUnauthorized: true } : undefined,
  });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async close() {
      await pool.end();
    },
  };
}

function needsSsl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get("sslmode") === "disable") return false;
    if (u.searchParams.get("sslmode")) return true;
    const host = u.hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local"));
  } catch {
    return false;
  }
}
