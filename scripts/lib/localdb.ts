// Local Postgres for development and tests. Never points at Neon: the admin
// connection must be on localhost, and DATABASE_URL from the environment is
// deliberately ignored here.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

export const LOCAL_PORT = 54329;
export const DEFAULT_DB = "strout_vault";
export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const DATA_DIR = path.join(REPO_ROOT, ".data");
export const PG_DATA_DIR = path.join(DATA_DIR, "pg");
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "db/migrations");
export const SEED_FILE = path.join(REPO_ROOT, "db/seed.sql");
export const SAMPLE_MEDIA_DIR = path.join(REPO_ROOT, "db/sample-media");
/** The two restricted Postgres roles the MCP server connects as (see db/migrations/0006_mcp.sql). */
export const MCP_ROLES = ["mcp_reader", "mcp_proposer"] as const;

export interface LocalServer {
  /** Connection URL for the maintenance database. */
  adminUrl: string;
  host: string;
  port: number;
  user: string;
  how: "env" | "managed" | "docker";
}

const log = (msg: string) => console.log(`[db:local] ${msg}`);

function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

async function canConnect(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

function findPgBin(): string | null {
  const candidates = [
    process.env.PG_BIN,
    ...["18", "17", "16", "15", "14"].flatMap((v) => [
      `/usr/lib/postgresql/${v}/bin`,
      `/opt/homebrew/opt/postgresql@${v}/bin`,
      `/usr/local/opt/postgresql@${v}/bin`,
      `/Applications/Postgres.app/Contents/Versions/${v}/bin`,
    ]),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "pg_ctl")) && fs.existsSync(path.join(dir, "initdb"))) return dir;
  }
  const which = spawnSync("sh", ["-c", "command -v pg_ctl"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
  return null;
}

/** Postgres refuses to run as root; on Linux as root we run the cluster as the `postgres` user. */
function runAs(): string[] {
  if (process.platform === "linux" && process.getuid?.() === 0) {
    const hasUser = spawnSync("id", ["-u", "postgres"]).status === 0;
    if (hasUser) {
      if (spawnSync("sh", ["-c", "command -v runuser"]).status === 0) return ["runuser", "-u", "postgres", "--"];
      return ["su", "postgres", "-c"];
    }
  }
  return [];
}

function run(cmd: string[], opts: { quiet?: boolean } = {}): { ok: boolean; out: string } {
  const prefix = runAs();
  let full = [...prefix, ...cmd];
  if (prefix[0] === "su") full = [...prefix, cmd.map((c) => JSON.stringify(c)).join(" ")];
  const r = spawnSync(full[0], full.slice(1), { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!opts.quiet && r.status !== 0) log(out.trim());
  return { ok: r.status === 0, out };
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await canConnect(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function startManaged(): Promise<LocalServer | null> {
  const bin = findPgBin();
  if (!bin) return null;
  const user = "postgres";
  const adminUrl = `postgres://${user}@127.0.0.1:${LOCAL_PORT}/postgres`;
  if (await canConnect(adminUrl)) return { adminUrl, host: "127.0.0.1", port: LOCAL_PORT, user, how: "managed" };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (runAs().length) spawnSync("chown", ["postgres:postgres", DATA_DIR]);
  if (!fs.existsSync(path.join(PG_DATA_DIR, "PG_VERSION"))) {
    log(`initialising a Postgres cluster in ${path.relative(REPO_ROOT, PG_DATA_DIR)}`);
    const r = run([path.join(bin, "initdb"), "-D", PG_DATA_DIR, "-U", user, "--auth=trust", "-E", "UTF8"]);
    if (!r.ok) return null;
  }
  const logFile = path.join(DATA_DIR, "pg.log");
  log(`starting Postgres on 127.0.0.1:${LOCAL_PORT} (log: ${path.relative(REPO_ROOT, logFile)})`);
  const socketDir = fs.existsSync("/tmp") ? "/tmp" : DATA_DIR;
  const r = run([
    path.join(bin, "pg_ctl"),
    "-D",
    PG_DATA_DIR,
    "-l",
    logFile,
    "-o",
    `-p ${LOCAL_PORT} -k ${socketDir} -c listen_addresses=127.0.0.1`,
    "start",
  ]);
  if (!r.ok) return null;
  if (!(await waitFor(adminUrl, 15000))) return null;
  return { adminUrl, host: "127.0.0.1", port: LOCAL_PORT, user, how: "managed" };
}

async function startDocker(): Promise<LocalServer | null> {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return null;
  const name = "strout-vault-pg";
  const adminUrl = `postgres://postgres@127.0.0.1:${LOCAL_PORT}/postgres`;
  const running = spawnSync("docker", ["ps", "-q", "-f", `name=^${name}$`], { encoding: "utf8" }).stdout.trim();
  if (!running) {
    const exists = spawnSync("docker", ["ps", "-aq", "-f", `name=^${name}$`], { encoding: "utf8" }).stdout.trim();
    if (exists) {
      log(`starting docker container ${name}`);
      spawnSync("docker", ["start", name], { stdio: "inherit" });
    } else {
      log(`creating docker container ${name} (pgvector/pgvector:pg17) on port ${LOCAL_PORT}`);
      const r = spawnSync(
        "docker",
        ["run", "-d", "--name", name, "-p", `${LOCAL_PORT}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:pg17"],
        { stdio: "inherit" },
      );
      if (r.status !== 0) return null;
    }
  }
  if (!(await waitFor(adminUrl, 40000))) return null;
  return { adminUrl, host: "127.0.0.1", port: LOCAL_PORT, user: "postgres", how: "docker" };
}

/**
 * Find or start a local Postgres, in this order:
 *   1. LOCAL_PG_URL (must be localhost) - use an existing server you run yourself
 *   2. a cluster this script manages under .data/pg (needs pg_ctl/initdb on the machine)
 *   3. a docker container (pgvector/pgvector:pg17; `docker compose up -d` starts the same image)
 */
export async function ensureLocalServer(): Promise<LocalServer> {
  const envUrl = process.env.LOCAL_PG_URL;
  if (envUrl) {
    if (!isLocalHost(envUrl)) throw new Error("LOCAL_PG_URL must point at localhost; this tool never touches a remote database.");
    if (!(await canConnect(envUrl))) throw new Error(`cannot connect to LOCAL_PG_URL (${envUrl.replace(/:[^:@/]+@/, ":***@")})`);
    const u = new URL(envUrl);
    return { adminUrl: envUrl, host: u.hostname, port: Number(u.port || 5432), user: u.username || "postgres", how: "env" };
  }
  const managed = await startManaged();
  if (managed) return managed;
  log("no local pg_ctl/initdb found (or it failed); trying docker");
  const docker = await startDocker();
  if (docker) return docker;
  throw new Error(
    "Could not find or start a local Postgres. Install Postgres (brew install postgresql@16), start Docker, or set LOCAL_PG_URL.",
  );
}

export function databaseUrlFor(server: LocalServer, dbName: string, role?: string): string {
  const u = new URL(server.adminUrl);
  u.pathname = `/${dbName}`;
  if (role) {
    u.username = role;
    u.password = "";
  }
  return u.toString();
}

/**
 * Creates the restricted MCP roles (login, no password: local servers use trust auth) when
 * they do not exist. Cluster-wide, so once per server. On a server we do not administer
 * (LOCAL_PG_URL) this may be refused; the caller then falls back to the admin role.
 */
export async function ensureMcpRoles(server: LocalServer, say: (m: string) => void = log): Promise<boolean> {
  const admin = new pg.Client({ connectionString: server.adminUrl });
  await admin.connect();
  try {
    for (const role of MCP_ROLES) {
      const { rowCount } = await admin.query(`select 1 from pg_roles where rolname = $1`, [role]);
      if (!rowCount) await admin.query(`create role "${role}" login`);
    }
    return true;
  } catch (err) {
    say(`could not create the MCP roles (${(err as Error).message}); MCP tests and dev will use the admin role instead`);
    return false;
  } finally {
    await admin.end();
  }
}

export interface ResetOptions {
  seed?: boolean;
  /** Where the local storage driver keeps files; sample videos are copied under <dir>/samples. */
  storageDir?: string | null;
  quiet?: boolean;
}

export interface ResetResult {
  url: string;
  vectorAvailable: boolean;
  /** Connection URLs for the restricted MCP roles (the admin URL when the roles could not be created). */
  readerUrl: string;
  proposerUrl: string;
  mcpRoles: boolean;
}

/** Drops and recreates a LOCAL database, applies db/migrations/*.sql in order, loads db/seed.sql. */
export async function resetDatabase(server: LocalServer, dbName: string, opts: ResetOptions = {}): Promise<ResetResult> {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error("database name must be a simple identifier");
  const say = opts.quiet ? () => {} : log;
  const mcpRoles = await ensureMcpRoles(server, say);
  const admin = new pg.Client({ connectionString: server.adminUrl });
  await admin.connect();
  try {
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`drop database if exists "${dbName}"`);
    await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = databaseUrlFor(server, dbName);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let vectorAvailable = true;
  try {
    const ext = await c.query(`select 1 from pg_available_extensions where name = 'vector'`);
    vectorAvailable = (ext.rowCount ?? 0) > 0;
    if (!vectorAvailable) {
      say("the `vector` extension is not installed locally: chunks.embedding uses real[] instead of vector(1024) and the extension is skipped. Production is unaffected.");
    }
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    for (const f of files) {
      let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      if (!vectorAvailable) {
        sql = sql
          .replace(/create extension if not exists vector;/gi, "-- create extension vector: skipped (not available locally)")
          .replace(/vector\(\s*\d+\s*\)/gi, "real[]");
      }
      await c.query(sql);
      say(`applied ${f}`);
    }
    if (opts.seed !== false) {
      await c.query(fs.readFileSync(SEED_FILE, "utf8"));
      const counts = await c.query(
        `select (select count(*) from interactions) as recordings, (select count(*) from segments) as segments,
                (select count(*) from parties) as parties, (select count(*) from media) as media`,
      );
      const r = counts.rows[0];
      say(`loaded db/seed.sql: ${r.recordings} recordings, ${r.segments} segments, ${r.parties} parties, ${r.media} media rows`);
      if (opts.storageDir) await installSampleMedia(c, opts.storageDir, say);
    }
  } finally {
    await c.end();
  }
  return {
    url,
    vectorAvailable,
    readerUrl: mcpRoles ? databaseUrlFor(server, dbName, "mcp_reader") : url,
    proposerUrl: mcpRoles ? databaseUrlFor(server, dbName, "mcp_proposer") : url,
    mcpRoles,
  };
}

/** Copies db/sample-media/* into the local storage dir and records their real size + sha256. */
export async function installSampleMedia(c: pg.Client, storageDir: string, say: (m: string) => void = log): Promise<void> {
  const dest = path.join(path.resolve(storageDir), "samples");
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(SAMPLE_MEDIA_DIR).filter((x) => /\.(webm|mp4)$/.test(x))) {
    const src = path.join(SAMPLE_MEDIA_DIR, f);
    const to = path.join(dest, f);
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(src).size) fs.copyFileSync(src, to);
    const buf = fs.readFileSync(src);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    await c.query(`update media set bytes = $2, sha256 = $3 where storage = 'local' and storage_key = $1`, [`samples/${f}`, buf.length, sha]);
    n++;
  }
  say(`installed ${n} sample videos into ${path.relative(REPO_ROOT, dest)} (playable under STORAGE_DRIVER=local)`);
}

/** Writes a development .env if none exists so `npm run dev` works right away. */
export function ensureDevEnv(databaseUrl: string, mcp?: { readerUrl: string; proposerUrl: string }): { created: boolean; email: string; password: string } {
  const envPath = path.join(REPO_ROOT, ".env");
  const email = "dev@strout.local";
  const password = "vault-dev-password";
  if (fs.existsSync(envPath)) return { created: false, email, password };
  // Pre-computed bcrypt hash of "vault-dev-password" (12 rounds), dev only.
  const hash = "$2b$12$n.14Mj6k0QzvENVWdt4cSuCT51Njj30l5Hsv60FoeGYekXVMpWypO";
  const body = `# Local development settings written by npm run db:local. Safe to edit; never commit.
DATABASE_URL=${databaseUrl}
PORT=3000
PUBLIC_URL=http://localhost:3000
SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}
ADMIN_EMAIL=${email}
ADMIN_PASSWORD_HASH=${hash}
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=./.data/storage
# MCP server (docs/MCP.md): restricted roles for the read tools and propose_update, and a
# deterministic fake embedding provider so hybrid search works locally without an API key.
MCP_READER_DATABASE_URL=${mcp?.readerUrl ?? databaseUrl}
MCP_PROPOSER_DATABASE_URL=${mcp?.proposerUrl ?? databaseUrl}
EMBEDDING_PROVIDER=fake
`;
  fs.writeFileSync(envPath, body);
  return { created: true, email, password };
}
