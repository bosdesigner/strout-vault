import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createStorage } from "./storage/index.ts";
import { EnvAdminAuthProvider } from "./auth/envAdmin.ts";
import { createApp } from "./app.ts";

async function main() {
  const config = loadConfig();
  const dbHandle = createDb(config.DATABASE_URL);
  const storage = createStorage(config);
  const auth = new EnvAdminAuthProvider(config.ADMIN_EMAIL, config.ADMIN_PASSWORD_HASH);

  // Vite middleware only when running from source (tsx). The esbuild bundle in dist/ serves the built client.
  const runningFromSource = import.meta.url.endsWith(".ts");
  const isDev = runningFromSource && !config.isProd && process.env.VITE_DEV !== "0";
  const { app } = await createApp({
    config,
    dbHandle,
    storage,
    auth,
    devMiddleware: isDev
      ? async (app) => {
          // Vite in middleware mode: one process serves API and client with HMR.
          const { createServer } = await import("vite");
          const vite = await createServer({
            configFile: new URL("../vite.config.ts", import.meta.url).pathname,
            server: { middlewareMode: true, hmr: process.env.REPL_ID ? { clientPort: 443 } : undefined },
            appType: "spa",
          });
          app.use(vite.middlewares);
        }
      : undefined,
  });

  const server = app.listen(config.PORT, "0.0.0.0", () => {
    console.log(
      `Strout Vault listening on http://0.0.0.0:${config.PORT} (${config.isProd ? "production" : isDev ? "development" : "built client"}, storage=${storage.name})`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      dbHandle.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
