import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { ADMIN_EMAIL, ADMIN_PASSWORD, buildTestApp, login, type TestApp } from "../helpers.ts";

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp();
});
afterAll(() => t.close());

describe("auth", () => {
  it("rejects unauthenticated API requests and /api/auth/me", async () => {
    for (const path of ["/api/interactions", "/api/search?q=x", "/api/parties?q=a", "/api/workspaces", "/api/interactions/1", "/api/auth/me"]) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
    }
    expect((await request(t.app).post("/api/uploads/check").send({ sha256: "a".repeat(64) })).status).toBe(401);
  });

  it("/healthz is public and reports db, storage and schema version without secrets", async () => {
    const res = await request(t.app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("ok");
    expect(res.body.storage).toBe("ok");
    expect(res.body.schema.version).toMatch(/^v0\.\d+ /);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\/|secret/i);
  });

  it("logs in with the right password and sets an httpOnly, SameSite=Lax cookie", async () => {
    const res = await request(t.app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^sv_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("accepts the email case-insensitively", async () => {
    const res = await request(t.app).post("/api/auth/login").send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    const a = await request(t.app).post("/api/auth/login").send({ email: ADMIN_EMAIL, password: "wrong" });
    const b = await request(t.app).post("/api/auth/login").send({ email: "nobody@test.local", password: ADMIN_PASSWORD });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.headers["set-cookie"]).toBeUndefined();
  });

  it("lets a logged-in session read /api/auth/me and the library", async () => {
    const { agent, csrf } = await login(t.app);
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBe(csrf);
    expect((await agent.get("/api/interactions")).status).toBe(200);
  });

  it("requires the CSRF token on state-changing requests", async () => {
    const { agent, csrf } = await login(t.app);
    const noToken = await agent.patch("/api/interactions/1").send({ title: "x" });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error).toBe("csrf_token_invalid");
    const badToken = await agent.patch("/api/interactions/1").set("x-csrf-token", "nope").send({ title: "x" });
    expect(badToken.status).toBe(403);
    const before = (await agent.get("/api/interactions/1")).body.title as string;
    const ok = await agent.patch("/api/interactions/1").set("x-csrf-token", csrf).send({ title: before });
    expect(ok.status).toBe(200);
  });

  it("rejects a forged session cookie", async () => {
    const res = await request(t.app).get("/api/interactions").set("Cookie", "sv_session=eyJmYWtlIjp0cnVlfQ.bm9wZQ");
    expect(res.status).toBe(401);
  });

  it("logs out (with CSRF) and the cookie no longer works", async () => {
    const { agent, csrf } = await login(t.app);
    expect((await agent.post("/api/auth/logout")).status).toBe(403);
    const out = await agent.post("/api/auth/logout").set("x-csrf-token", csrf);
    expect(out.status).toBe(200);
    expect(out.headers["set-cookie"]?.[0]).toMatch(/sv_session=;/);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("rate-limits repeated failed logins per IP", async () => {
    const fresh = await buildTestApp({ LOGIN_RATE_LIMIT_MAX: "3" });
    try {
      const ip = "203.0.113.9";
      for (let i = 0; i < 3; i++) {
        const r = await request(fresh.app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: ADMIN_EMAIL, password: "bad" });
        expect(r.status).toBe(401);
      }
      const blocked = await request(fresh.app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(blocked.status).toBe(429);
      // Another IP is unaffected.
      const other = await request(fresh.app).post("/api/auth/login").set("X-Forwarded-For", "203.0.113.10").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(other.status).toBe(200);
    } finally {
      await fresh.close();
    }
  });
});
