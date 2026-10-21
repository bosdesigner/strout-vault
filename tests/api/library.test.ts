import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import type { LibraryPage, RecordingDetail } from "../../shared/types.ts";

let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await buildTestApp();
  s = await login(t.app);
});
afterAll(() => t.close());

const list = async (qs = "") => {
  const res = await s.agent.get(`/api/interactions${qs ? `?${qs}` : ""}`);
  expect(res.status).toBe(200);
  return res.body as LibraryPage;
};

describe("library", () => {
  it("lists newest first with cursor pagination and no overlaps", async () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let last: string | null = null;
    let pages = 0;
    do {
      const page: LibraryPage = await list(`limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      pages++;
      for (const it of page.items) {
        expect(seen.has(it.id)).toBe(false);
        seen.add(it.id);
        if (last && it.occurredAt) expect(it.occurredAt <= last).toBe(true);
        last = it.occurredAt;
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBeGreaterThanOrEqual(40);
  });

  it("includes preview text for generic titles, participants, duration and status", async () => {
    const page = await list("limit=100");
    const generic = page.items.find((i) => i.title === "Ben Strout's Personal Meeting Room");
    expect(generic?.preview).toBeTruthy();
    expect(generic!.preview!.length).toBeGreaterThan(20);
    const named = page.items.find((i) => i.title === "Pool house tile sample walkthrough")!;
    expect(named.participants.length).toBeGreaterThan(0);
    expect(named.participants.length).toBeLessThanOrEqual(3);
    expect(named.durationSec).toBe(120);
    expect(named.hasVideo).toBe(true);
    const inflight = page.items.find((i) => i.pipelineStatus === "transcribing");
    expect(inflight).toBeTruthy();
  });

  it("filters by year, source, workspace, person and has-video", async () => {
    const y = await list("from=2024-01-01&to=2024-12-31&limit=100");
    expect(y.items.length).toBeGreaterThan(0);
    for (const it of y.items) expect(it.occurredAt?.slice(0, 4)).toBe("2024");

    const calls = await list("source=iphone_call&limit=100");
    expect(calls.items.length).toBeGreaterThan(0);
    for (const it of calls.items) expect(it.source).toBe("iphone_call");

    const ws = await list("workspace=southern_shutter&limit=100");
    expect(ws.items.length).toBeGreaterThan(0);
    for (const it of ws.items) expect(it.workspaceId).toBe("southern_shutter");

    const kevin = (await s.agent.get("/api/parties?q=Kevin")).body.items[0];
    const byKevin = await list(`party=${kevin.id}&limit=100`);
    expect(byKevin.items.length).toBeGreaterThan(0);
    const { rows } = await t.dbHandle.pool.query(`select interaction_id from interaction_participants where party_id = $1`, [kevin.id]);
    expect(byKevin.items.length).toBe(rows.length);

    // Under the local driver only storage='local' rows with relative keys are playable (the three seeded samples,
    // plus anything other test files uploaded into local storage).
    const video = await list("hasVideo=true&limit=100");
    for (const title of ["Kevin: quick check on the Conroe call time", "Pool house tile sample walkthrough", "Porch measure notes (phone)"]) {
      expect(video.items.map((i) => i.title)).toContain(title);
    }
    expect(video.items.some((i) => i.title === "Heights bungalow: beam sizes and permit set")).toBe(false); // zoom + Mac path only
    const noVideo = await list("hasVideo=false&limit=100");
    const total = await list("limit=100");
    expect(noVideo.items.length + video.items.length).toBe(total.items.length);
  });

  it("reports pipeline statuses for polling", async () => {
    const page = await list("limit=5");
    const ids = page.items.map((i) => i.id);
    const res = await s.agent.get(`/api/interactions/status?ids=${ids.join(",")}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id).sort()).toEqual([...ids].sort());
  });

  it("rejects bad filter values", async () => {
    expect((await s.agent.get("/api/interactions?from=yesterday")).status).toBe(400);
    expect((await s.agent.get("/api/interactions?limit=0")).status).toBe(400);
  });
});

describe("recording", () => {
  it("returns detail with a playable local video, files, people with role chips, facts and clips", async () => {
    const page = await list("limit=100");
    const id = page.items.find((i) => i.title === "Pool house tile sample walkthrough")!.id;
    const res = await s.agent.get(`/api/interactions/${id}`);
    expect(res.status).toBe(200);
    const r = res.body as RecordingDetail;
    expect(r.video?.url).toMatch(/^\/api\/storage\/local\/object\?key=samples%2Fsample-2\.webm/);
    expect(r.files.some((f) => f.playable)).toBe(true);
    expect(r.participants.length).toBe(3);
    expect(r.participants.find((p) => p.name === "Maria Delgado")?.roles[0]).toMatchObject({ workspaceId: "strout_arch", role: "client" });
    expect(r.clips.some((c) => c.status === "new")).toBe(true);
    expect(r.workspace?.id).toBe("strout_arch");

    const seg = await s.agent.get(`/api/interactions/${id}/segments`);
    expect(seg.status).toBe(200);
    expect(seg.body.anchored).toBe(true);
    expect(seg.body.lines.length).toBeGreaterThan(10);
    expect(seg.body.lines.find((l: { startSec: number }) => l.startSec === 42).text).toMatch(/pelican roof tiles/);

    // The presigned local URL streams with Range support (and needs the session cookie).
    const head = await s.agent.get(r.video!.url).set("Range", "bytes=0-99");
    expect(head.status).toBe(206);
    expect(head.headers["content-range"]).toMatch(/^bytes 0-99\//);
    expect(head.headers["content-type"]).toBe("video/webm");
    const anon = await (await import("supertest")).default(t.app).get(r.video!.url);
    expect(anon.status).toBe(401);
  });

  it("shows no video for a recording whose files are only on the Mac or at Zoom", async () => {
    const { rows } = await t.dbHandle.pool.query(
      `select i.id from interactions i where not exists (select 1 from media m where m.interaction_id = i.id and m.storage not in ('zoom','local'))
         and not exists (select 1 from media m where m.interaction_id = i.id and m.storage_key like 'samples/%') limit 1`,
    );
    const res = await s.agent.get(`/api/interactions/${rows[0].id}`);
    expect(res.body.video).toBeNull();
    expect(res.body.files.length).toBeGreaterThan(0);
  });

  it("edits title and tags inline and bumps updated_at", async () => {
    const id = (await list("limit=1")).items[0].id;
    const before = (await s.agent.get(`/api/interactions/${id}`)).body as RecordingDetail;
    const res = await s.agent.patch(`/api/interactions/${id}`).set("x-csrf-token", s.csrf).send({ title: "Renamed by test", tags: ["alpha", "beta"] });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed by test");
    expect(res.body.tags).toEqual(["alpha", "beta"]);
    expect(res.body.updatedAt > before.updatedAt!).toBe(true);
    expect((await s.agent.patch(`/api/interactions/${id}`).set("x-csrf-token", s.csrf).send({ title: "" })).status).toBe(400);
    expect((await s.agent.patch(`/api/interactions/${id}`).set("x-csrf-token", s.csrf).send({ bogus: 1 })).status).toBe(400);
    await s.agent.patch(`/api/interactions/${id}`).set("x-csrf-token", s.csrf).send({ title: before.title, tags: before.tags });
  });

  it("approves and rejects clip candidates", async () => {
    const { rows } = await t.dbHandle.pool.query(`select id from clip_candidates where status = 'new' order by id limit 1`);
    const clipId = rows[0].id;
    const ok = await s.agent.patch(`/api/clips/${clipId}`).set("x-csrf-token", s.csrf).send({ status: "approved" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("approved");
    const back = await s.agent.patch(`/api/clips/${clipId}`).set("x-csrf-token", s.csrf).send({ status: "new" });
    expect(back.body.status).toBe("new");
    expect((await s.agent.patch(`/api/clips/${clipId}`).set("x-csrf-token", s.csrf).send({ status: "cut" })).status).toBe(400);
    expect((await s.agent.patch(`/api/clips/999999`).set("x-csrf-token", s.csrf).send({ status: "approved" })).status).toBe(404);
  });

  it("404s on a missing recording", async () => {
    expect((await s.agent.get("/api/interactions/999999")).status).toBe(404);
  });
});

describe("parties", () => {
  it("suggests people and orgs by partial name", async () => {
    const res = await s.agent.get("/api/parties?q=mc");
    expect(res.body.items[0].name).toBe("Kevin McGuire");
    expect(res.body.items[0].detail).toMatch(/Another Story · contractor/);
    const org = await s.agent.get("/api/parties?q=gulf");
    expect(org.body.items[0].kind).toBe("org");
  });
  it("returns a person with roles, affiliations and recordings", async () => {
    const id = (await s.agent.get("/api/parties?q=Lena")).body.items[0].id;
    const res = await s.agent.get(`/api/parties/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.affiliations[0].other.name).toBe("Gulf Coast Millwork");
    expect(res.body.interactions.length).toBeGreaterThan(0);
  });
  it("lists the six workspaces", async () => {
    const res = await s.agent.get("/api/workspaces");
    expect(res.body.items.map((w: { id: string }) => w.id).sort()).toEqual(["another_story", "credvault", "phalanx", "sepp", "southern_shutter", "strout_arch"]);
  });
});
