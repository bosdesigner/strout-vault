import { inject } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { loadConfig, type Config } from "../server/config.ts";
import { createDb, type DbHandle } from "../server/db/client.ts";
import { LocalStorageDriver } from "../server/storage/local.ts";
import { EnvAdminAuthProvider } from "../server/auth/envAdmin.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/auth/password.ts";

export const ADMIN_EMAIL = "owner@test.local";
export const ADMIN_PASSWORD = "correct horse battery staple";

export interface TestApp {
  app: Express;
  config: Config;
  dbHandle: DbHandle;
  storage: LocalStorageDriver;
  close(): Promise<void>;
}

let cachedHash: string | null = null;

export async function buildTestApp(overrides: Partial<Record<string, string>> = {}): Promise<TestApp> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD);
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: inject("databaseUrl"),
    PORT: "3999",
    SESSION_SECRET: "test-secret-test-secret-test-secret",
    ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: cachedHash,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: inject("storageDir"),
    LOGIN_RATE_LIMIT_MAX: "5",
    LOGIN_RATE_WINDOW_MS: "60000",
    ...overrides,
  };
  const config = loadConfig(env);
  const dbHandle = createDb(config.DATABASE_URL);
  const storage = new LocalStorageDriver({ rootDir: config.LOCAL_STORAGE_DIR, secret: config.SESSION_SECRET });
  const auth = new EnvAdminAuthProvider(config.ADMIN_EMAIL, config.ADMIN_PASSWORD_HASH);
  const { app } = await createApp({ config, dbHandle, storage, auth, serveStatic: false });
  return { app, config, dbHandle, storage, close: () => dbHandle.close() };
}

export interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
}

/** Logs in and returns a cookie-carrying agent plus the CSRF token. */
export async function login(app: Express, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<Session> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return { agent, csrf: res.body.csrfToken as string };
}
