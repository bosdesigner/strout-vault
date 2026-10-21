// Resets the e2e database + local storage, then starts the app for Playwright.
// Everything here is local: a throwaway Postgres database and ./.data/storage-e2e.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "./lib/localdb.ts";
import { hashPassword } from "../server/auth/password.ts";

export const E2E_EMAIL = "e2e@strout.local";
export const E2E_PASSWORD = "e2e-password-123";

const port = process.env.E2E_PORT ?? "3100";
const storageDir = path.join(REPO_ROOT, ".data/storage-e2e");
fs.rmSync(storageDir, { recursive: true, force: true });

const server = await ensureLocalServer();
const { url } = await resetDatabase(server, "strout_vault_e2e", { seed: true, storageDir, quiet: true });
const hash = await hashPassword(E2E_PASSWORD);

const child = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(REPO_ROOT, "server/index.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: url,
    PORT: port,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: "e2e-session-secret-e2e-session-secret",
    ADMIN_EMAIL: E2E_EMAIL,
    ADMIN_PASSWORD_HASH: hash,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: storageDir,
    LOGIN_RATE_LIMIT_MAX: "100",
  },
});
const stop = () => {
  child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
