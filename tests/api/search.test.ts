import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import type { SearchResponse } from "../../shared/types.ts";

let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await buildTestApp();
  s = await login(t.app);
});
afterAll(() => t.close());

const search = async (q: string, extra: Record<string, string> = {}) => {
  const qs = new URLSearchParams({ q, ...extra });
  const res = await s.agent.get(`/api/search?${qs}`);
  expect(res.status).toBe(200);
  return res.body as SearchResponse;
};
const allText = (r: SearchResponse) => r.groups.flatMap((g) => g.lines.map((l) => l.parts.map((p) => p.t).join("")));

describe("search", () => {
  it("finds a unique seeded phrase in exactly one recording, at the right line", async () => {
    const r = await search("pelican roof tiles");
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0];
    expect(g.title).toBe("Pool house tile sample walkthrough");
    expect(g.hitCount).toBe(1);
    expect(g.lines[0].startSec).toBe(42);
    expect(g.lines[0].parts.filter((p) => p.m).map((p) => p.t.toLowerCase())).toEqual(["pelican", "roof", "tiles"]);
  });

  it("groups hits by recording with at most three highlighted lines each", async () => {
    const r = await search("copper gutters");
    expect(r.groups.length).toBeGreaterThan(3);
    for (const g of r.groups) {
      expect(g.lines.length).toBeGreaterThan(0);
      expect(g.lines.length).toBeLessThanOrEqual(3);
      expect(g.hitCount).toBeGreaterThanOrEqual(g.lines.length);
      for (const l of g.lines) expect(l.parts.some((p) => p.m)).toBe(true);
    }
    // Groups are unique per recording.
    expect(new Set(r.groups.map((g) => g.interactionId)).size).toBe(r.groups.length);
  });

  it("treats a quoted phrase as adjacent words", async () => {
    const loose = await search("gutters copper");
    const phrase = await search('"copper gutters"');
    expect(phrase.groups.length).toBeGreaterThan(0);
    expect(phrase.groups.length).toBeLessThanOrEqual(loose.groups.length);
    for (const text of allText(phrase)) expect(text.toLowerCase()).toMatch(/copper gutters/);
    // Reversed phrase never appears in the seed.
    expect((await search('"gutters copper"')).groups).toHaveLength(0);
  });

  it("supports OR", async () => {
    const a = await search("skylight", { pageSize: "50" });
    const b = await search("dormer", { pageSize: "50" });
    const both = await search("skylight OR dormer", { pageSize: "50" });
    const union = new Set([...a.groups, ...b.groups].map((g) => g.interactionId));
    expect(new Set(both.groups.map((g) => g.interactionId))).toEqual(union);
  });

  it("supports -exclusion", async () => {
    const r = await search("shutters -cedar", { pageSize: "50" });
    expect(r.groups.length).toBeGreaterThan(0);
    for (const text of allText(r)) {
      expect(text.toLowerCase()).toMatch(/shutter/);
      expect(text.toLowerCase()).not.toMatch(/cedar/);
    }
  });

  it("filters by workspace, date range and person", async () => {
    const all = await search("permit", { pageSize: "50" });
    const ws = await search("permit", { workspace: "strout_arch", pageSize: "50" });
    expect(ws.groups.length).toBeGreaterThan(0);
    expect(ws.groups.length).toBeLessThan(all.groups.length);
    for (const g of ws.groups) expect(g.workspaceId).toBe("strout_arch");

    const y2024 = await search("permit", { from: "2024-01-01", to: "2024-12-31", pageSize: "50" });
    for (const g of y2024.groups) expect(g.occurredAt?.slice(0, 4)).toBe("2024");
    expect(y2024.groups.length).toBeLessThan(all.groups.length);

    const maria = (await s.agent.get("/api/parties?q=Maria%20Delgado")).body.items[0];
    const byPerson = await search("permit", { party: String(maria.id), pageSize: "50" });
    expect(byPerson.groups.length).toBeGreaterThan(0);
    const ids = byPerson.groups.map((g) => g.interactionId);
    const { rows } = await t.dbHandle.pool.query(`select interaction_id from interaction_participants where party_id = $1`, [maria.id]);
    const allowed = new Set(rows.map((r) => r.interaction_id));
    for (const id of ids) expect(allowed.has(id)).toBe(true);
  });

  it("paginates by group", async () => {
    const p1 = await search("the", { pageSize: "5", page: "1" });
    const p2 = await search("the", { pageSize: "5", page: "2" });
    // "the" is a stopword: no hits at all is the correct answer.
    expect(p1.groups).toHaveLength(0);
    const q1 = await search("timeline", { pageSize: "3", page: "1" });
    const q2 = await search("timeline", { pageSize: "3", page: "2" });
    expect(q1.groups).toHaveLength(3);
    expect(q1.hasMore).toBe(true);
    const overlap = q2.groups.filter((g) => q1.groups.some((h) => h.interactionId === g.interactionId));
    expect(overlap).toHaveLength(0);
    expect(p2.groups).toHaveLength(0);
  });

  it("returns nothing for an empty query and never throws on odd input", async () => {
    expect((await search("")).groups).toHaveLength(0);
    for (const q of ['"', "OR", "-", "a OR", "!!!", "(((", "a:b & c | d"]) {
      const res = await s.agent.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
  });
});
