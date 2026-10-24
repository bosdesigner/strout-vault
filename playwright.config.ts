import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against a seeded local Postgres ("strout_vault_e2e")
// and the local storage driver. scripts/e2e-server.ts resets the database,
// installs the sample videos and starts the app on port 3100.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: ".data/test-results",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/e2e-server.ts",
    url: `${BASE}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { E2E_PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], storageState: ".data/e2e-auth.json" },
      dependencies: ["setup"],
    },
    {
      name: "iphone",
      use: { ...devices["iPhone 13"], browserName: "chromium", storageState: ".data/e2e-auth.json" },
      dependencies: ["setup"],
      testMatch: /(library|recording|phase2|phase3|phase4|phase5)\.spec\.ts/,
    },
  ],
});
