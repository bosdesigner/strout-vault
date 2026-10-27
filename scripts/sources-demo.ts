// npm run sources:demo: loads fake ingest history into the LOCAL development database so the
// Sources panel on /pipeline shows every status type (docs/ingest-verification/sources-panel.png).
// Refuses anything that is not a localhost database.
import pg from "pg";
import { loadConfig } from "../server/config.ts";
import { seedSourcesDemo } from "./lib/sources-demo.ts";

const config = loadConfig();
const host = new URL(config.DATABASE_URL).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`refusing: DATABASE_URL points at ${host}, not a local database`);
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
await seedSourcesDemo(pool);
await pool.end();
console.log("sources demo loaded: open /pipeline");
