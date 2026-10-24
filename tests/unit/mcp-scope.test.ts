import { describe, expect, it } from "vitest";
import { describeScope, parseStoredScope, resolveScope, scopeSql } from "../../server/mcp/scope.ts";
import { SlidingWindowLimiter } from "../../server/mcp/rateLimit.ts";
import { redactArgs } from "../../server/mcp/audit.ts";
import { signPending, verifyPending } from "../../server/mcp/auth/oauth.ts";
import { generatePat, hashToken, PAT_PREFIX } from "../../server/mcp/auth/tokens.ts";

const WS = ["another_story", "credvault", "phalanx", "sepp", "southern_shutter", "strout_arch"];
const fakePool = { query: async () => ({ rows: WS.map((id) => ({ id })) }) } as never;

describe("workspace scope", () => {
  it("validates stored scopes", () => {
    expect(parseStoredScope(["another_story", "*", "another_story"])).toEqual(["another_story", "*"]);
    expect(parseStoredScope([])).toEqual([]);
    expect(() => parseStoredScope("another_story")).toThrow();
    expect(() => parseStoredScope(["bad id!"])).toThrow();
    expect(() => parseStoredScope([1])).toThrow();
  });

  it("never lets * include phalanx unless it is listed explicitly", async () => {
    const star = await resolveScope(fakePool, ["*"]);
    expect(star.ids).toEqual(WS.filter((w) => w !== "phalanx"));
    expect(star.all).toBe(true);
    const withPhalanx = await resolveScope(fakePool, ["*", "phalanx"]);
    expect(withPhalanx.ids).toEqual(WS);
    const explicit = await resolveScope(fakePool, ["phalanx", "sepp"]);
    expect(explicit.ids).toEqual(["phalanx", "sepp"]);
    expect(explicit.all).toBe(false);
    expect((await resolveScope(fakePool, [])).ids).toEqual([]);
  });

  it("renders a parameterised predicate, and 'false' for an empty scope", async () => {
    const params: unknown[] = ["x"];
    const sql = scopeSql(await resolveScope(fakePool, ["sepp"]), params, "i.workspace_id");
    expect(sql).toBe("i.workspace_id = any($2::text[])");
    expect(params).toEqual(["x", ["sepp"]]);
    expect(scopeSql(await resolveScope(fakePool, []), [], "i.workspace_id")).toBe("false");
    expect(describeScope(["*"])).toMatch(/except phalanx/);
    expect(describeScope(["*", "phalanx"])).toMatch(/incl\. phalanx/);
    expect(describeScope([])).toBe("no workspaces");
  });
});

describe("rate limiter", () => {
  it("allows `limit` calls per window per key, then refuses until the window slides", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(3, 1000, () => t);
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("b").allowed).toBe(true);
    expect(l.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    const refused = l.check("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBe(1);
    t = 1001;
    expect(l.check("a").allowed).toBe(true);
  });
});

describe("audit redaction", () => {
  it("truncates long strings, drops secret-looking keys and caps depth", () => {
    const out = redactArgs({ query: "q".repeat(400), api_key: "shh", nested: { token: "x", ok: [1, 2, { deep: { deeper: { deepest: { too: { far: 1 } } } } }] } }) as Record<string, unknown>;
    expect(String(out.query)).toMatch(/^q{300}… \(400 chars\)$/);
    expect(out.api_key).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(JSON.stringify(out)).toContain("[…]");
  });
});

describe("tokens and signed authorization requests", () => {
  it("mints svt_ tokens whose hash is what gets stored", () => {
    const g = generatePat();
    expect(g.token.startsWith(PAT_PREFIX)).toBe(true);
    expect(g.prefix).toBe(g.token.slice(0, 10));
    expect(g.hash).toBe(hashToken(g.token));
    expect(g.hash).not.toContain(g.token.slice(4, 20));
    expect(generatePat().token).not.toBe(g.token);
  });

  it("signs the pending authorization and rejects tampering and expiry", () => {
    const p = { clientId: "c", redirectUri: "http://localhost:1/cb", codeChallenge: "ch", scopes: ["vault:read"], exp: Math.floor(Date.now() / 1000) + 60 };
    const token = signPending(p, "secret");
    expect(verifyPending(token, "secret")).toMatchObject(p);
    expect(verifyPending(token, "other")).toBeNull();
    expect(verifyPending(`${token}x`, "secret")).toBeNull();
    expect(verifyPending(signPending({ ...p, exp: Math.floor(Date.now() / 1000) - 1 }, "secret"), "secret")).toBeNull();
    expect(verifyPending(undefined, "secret")).toBeNull();
  });
});
