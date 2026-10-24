// npm run db:local [-- --db name] [--no-seed] [--no-env]
// Starts or uses a local Postgres, applies db/migrations/*.sql in order, loads
// db/seed.sql and installs the sample videos for the local storage driver.
import path from "node:path";
import { DEFAULT_DB, REPO_ROOT, ensureDevEnv, ensureLocalServer, resetDatabase } from "./lib/localdb.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbName = opt("--db") ?? DEFAULT_DB;
const storageDir = process.env.LOCAL_STORAGE_DIR ?? path.join(REPO_ROOT, ".data/storage");

const server = await ensureLocalServer();
console.log(`[db:local] using ${server.how === "env" ? "LOCAL_PG_URL" : server.how} Postgres at ${server.host}:${server.port}`);
const { url, readerUrl, proposerUrl } = await resetDatabase(server, dbName, { seed: !flag("--no-seed"), storageDir });

if (!flag("--no-env")) {
  const env = ensureDevEnv(url, { readerUrl, proposerUrl });
  if (env.created) {
    console.log(`[db:local] wrote .env for development. Login: ${env.email} / ${env.password}`);
  }
}
console.log(`\nDATABASE_URL=${url}`);
console.log("Run `npm run dev` and open http://localhost:3000");
