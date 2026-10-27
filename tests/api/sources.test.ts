// GET /api/pipeline/sources against seeded ingest history: every status type (live, configured but
// never run, not configured, erroring), the stale-collector warning, per-account rows, item counts
// from real rows, owner only, and nothing but statuses and counts in the response.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { seedSourcesDemo } from "../../scripts/lib/sources-demo.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import path from "node:path";

let t: TestApp;
let pool: pg.Pool;
let owner: Session;

beforeAll(async () => {
  const server = await ensureLocalServer();
  const storage = path.join(REPO_ROOT, ".data/storage-sources");
  const urls = await resetDatabase(server, "strout_vault_sources", { seed: true, storageDir: storage, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 2 });
  t = await buildTestApp({ DATABASE_URL: urls.url, LOCAL_STORAGE_DIR: storage, LOGIN_RATE_LIMIT_MAX: "200" });
  owner = await login(t.app);
});

afterAll(async () => {
  await pool?.end();
  await t?.close();
});

describe("GET /api/pipeline/sources", () => {
  it("is owner only", async () => {
    expect((await request(t.app).get("/api/pipeline/sources")).status).toBe(401);
  });

  it("with nothing connected: Zoom and every collector are not configured", async () => {
    const r = await owner.agent.get("/api/pipeline/sources");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.rows.map((x: { id: string; status: string }) => [x.id, x.status]));
    expect(by).toMatchObject({ zoom: "not_configured", gmail: "not_configured", imessage: "not_configured", "mac:voice_memo": "not_configured", ios_shortcut: "not_configured", meet: "not_configured", twilio: "not_configured" });
  });

  it("reads each status from the tables the ingest points write", async () => {
    await seedSourcesDemo(pool);
    const r = await owner.agent.get("/api/pipeline/sources");
    const rows = r.body.rows as Array<Record<string, unknown>>;
    const get = (id: string) => rows.find((x) => x.id === id)!;
    expect(rows.map((x) => x.id)).toEqual([
      "zoom",
      "gmail:ben@anotherstory.example",
      "gmail:ben@stroutarch.example",
      "gmail:ben.strout@gmail.example",
      "imessage",
      "mac:voice_memo",
      "mac:iphone_call",
      "mac:apple_note",
      "ios_shortcut",
      "meet:ben@anotherstory.example",
      "meet:ben.strout@gmail.example",
      "twilio",
    ]);
    expect(get("zoom")).toMatchObject({ status: "live", warning: null, items7d: 3 });
    expect(get("gmail:ben@anotherstory.example")).toMatchObject({ status: "live", items24h: 3, items7d: 6, total: 6 });
    expect(get("gmail:ben@stroutarch.example")).toMatchObject({ status: "never_run", total: 0 });
    expect(get("gmail:ben.strout@gmail.example")).toMatchObject({ status: "erroring", lastError: "token refresh failed: invalid_grant" });
    expect(get("imessage")).toMatchObject({ status: "live" });
    expect(String(get("imessage").warning)).toMatch(/no batch in 3 h/);
    expect(get("mac:voice_memo")).toMatchObject({ status: "live", total: 4, warning: null });
    expect(get("mac:iphone_call")).toMatchObject({ status: "erroring" });
    expect(String(get("mac:iphone_call").lastError)).toMatch(/1 item\(s\) failed in the last batch: object_missing/);
    expect(get("mac:apple_note")).toMatchObject({ status: "live", total: 12 });
    expect(get("ios_shortcut")).toMatchObject({ status: "never_run", total: 0 });
    expect(get("meet:ben@anotherstory.example")).toMatchObject({ status: "live", total: 4 });
    expect(get("meet:ben.strout@gmail.example")).toMatchObject({ status: "live", total: 0 });
    expect(String(get("meet:ben.strout@gmail.example").note)).toMatch(/no Meet recordings/);
    expect(get("twilio")).toMatchObject({ status: "not_configured" });
    // The seed has tracked numbers; without Twilio credentials on the web app they cannot record.
    expect(String(get("twilio").note)).toMatch(/TWILIO_ACCOUNT_SID/);
  });

  it("warns when the Mac collector has not checked in for an hour", async () => {
    await pool.query(`update import_runs set started_at = started_at - interval '2 hours', finished_at = finished_at - interval '2 hours' where source = 'apple_media'`);
    const r = await owner.agent.get("/api/pipeline/sources");
    const mac = r.body.rows.find((x: { id: string }) => x.id === "mac:voice_memo");
    expect(mac.warning).toMatch(/has not checked in for 2 h/);
  });

  it("carries statuses and counts only, never item titles or content", async () => {
    const r = await owner.agent.get("/api/pipeline/sources");
    expect(r.text).not.toContain("Demo ");
  });
});
