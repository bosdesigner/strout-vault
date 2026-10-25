import type pg from "pg";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { StorageDriver } from "./storage/types.ts";
import type { AuthProvider } from "./auth/types.ts";
import type { SessionOptions } from "./auth/session.ts";
import type { Mailer } from "./mail/types.ts";
import type { McpRuntime } from "./mcp/index.ts";

export interface AppContext {
  config: Config;
  pool: pg.Pool;
  db: Db;
  storage: StorageDriver;
  auth: AuthProvider;
  mailer: Mailer;
  fetchImpl: typeof fetch;
  sessionOptions: SessionOptions;
  /** Set once the MCP server is mounted (createApp does it); the admin pages read its status. */
  mcp?: McpRuntime;
}
