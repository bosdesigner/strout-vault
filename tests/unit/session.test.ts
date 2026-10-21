import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession, newSession } from "../../server/auth/session.ts";

const secret = "unit-test-secret-unit-test-secret";
const principal = { sub: "admin", email: "a@b.c", role: "owner" as const };

describe("session cookie", () => {
  it("round-trips a signed session", () => {
    const s = newSession(principal, 3600);
    const token = encodeSession(s, secret);
    const back = decodeSession(token, secret);
    expect(back?.email).toBe("a@b.c");
    expect(back?.csrf).toBe(s.csrf);
  });
  it("rejects a tampered payload, a wrong secret and an expired session", () => {
    const s = newSession(principal, 3600);
    const token = encodeSession(s, secret);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, email: "evil@x.y" })).toString("base64url");
    expect(decodeSession(`${forged}.${sig}`, secret)).toBeNull();
    expect(decodeSession(token, "another-secret")).toBeNull();
    expect(decodeSession(`${payload}.`, secret)).toBeNull();
    expect(decodeSession(encodeSession({ ...s, exp: Math.floor(Date.now() / 1000) - 1 }, secret), secret)).toBeNull();
    expect(decodeSession(undefined, secret)).toBeNull();
  });
  it("gives every session a fresh CSRF token", () => {
    expect(newSession(principal, 10).csrf).not.toBe(newSession(principal, 10).csrf);
  });
});
