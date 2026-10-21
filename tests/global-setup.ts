// Starts (or finds) the local Postgres and builds a fresh, seeded test
// database. Tests never touch Neon, B2 or R2.
import path from "node:path";
import fs from "node:fs";
import type { TestProject } from "vitest/node";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../scripts/lib/localdb.ts";

export const TEST_STORAGE_DIR = path.join(REPO_ROOT, ".data/storage-test");

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    storageDir: string;
  }
}

export default async function setup(project: TestProject) {
  const server = await ensureLocalServer();
  fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
  const { url } = await resetDatabase(server, "strout_vault_test", { seed: true, storageDir: TEST_STORAGE_DIR, quiet: true });
  project.provide("databaseUrl", url);
  project.provide("storageDir", TEST_STORAGE_DIR);
}
