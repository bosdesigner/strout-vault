// Phase 5: clip scouting (mock Claude) and rendering (real ffmpeg on the seeded
// sample video), on their own local database. Nothing reaches Anthropic, Neon,
// B2 or R2.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { loadConfig, type Config } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { runWorker } from "../../server/worker/run.ts";
import { ANTHROPIC_TEST_KEY, createMockServices } from "../mocks/zoomGroq.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-phase5");
const TMP = path.join(os.tmpdir(), "strout-vault-phase5-test");

let url: string;
let pool: pg.Pool;
let storage: LocalStorageDriver;
let mock: ReturnType<typeof createMockServices>;

function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url,
    SESSION_SECRET: "test-secret-test-secret-test-secret",
    ADMIN_EMAIL: "owner@test.local",
    ADMIN_PASSWORD_HASH: "$2b$12$n.14Mj6k0QzvENVWdt4cSuCT51Njj30l5Hsv60FoeGYekXVMpWypO",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: STORAGE,
    ANTHROPIC_API_KEY: ANTHROPIC_TEST_KEY,
    ANTHROPIC_API_URL: "https://anthropic.test",
    SCOUT_MONTHLY_BUDGET_USD: "5",
    SCOUT_MAX_PER_RUN: "3",
    ...overrides,
  });
}

function makeCtx(config: Config, extra: Partial<WorkerContext> = {}): WorkerContext {
  return {
    config,
    pool,
    storage,
    fetchImpl: mock.fetchImpl,
    sleep: async () => {},
    now: () => new Date(),
    log: () => {},
    tmpDir: TMP,
    tools: { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN },
    deadline: Date.now() + 10 * 60_000,
    bytesBudget: 1e12,
    ...extra,
  };
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0] as T;
}

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file]).toString();
  return JSON.parse(out) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  ({ url } = await resetDatabase(server, "strout_vault_phase5", { seed: true, storageDir: STORAGE, quiet: true }));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  mock = createMockServices([]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
});

describe("scout", () => {
  it("is off without a budget, and says how much is waiting", async () => {
    const r = await runWorker(makeCtx(makeConfig({ SCOUT_MONTHLY_BUDGET_USD: "0" })), { trigger: "test", steps: ["scout"] });
    expect(r.summary.scout).toMatchObject({ configured: false, scanned: 0, found: 0 });
    expect(r.summary.scout!.candidatesRecordings).toBeGreaterThan(0);
    expect(mock.calls.anthropic).toBe(0);
  });

  it("reads the newest unscouted transcripts with Claude, files in-range candidates and records the spend", async () => {
    const before = await one<{ n: number }>(`select count(*)::int as n from clip_candidates`);
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["scout"] });
    const s = r.summary.scout!;
    expect(s).toMatchObject({ configured: true, candidatesRecordings: 3, scanned: 3, waitingOnBudget: 0, failed: 0 });
    expect(s.found).toBeGreaterThanOrEqual(3);
    expect(s.spentUsd).toBeGreaterThan(0);
    expect(mock.calls.anthropic).toBeGreaterThanOrEqual(3);

    // The request shape: Opus 5.5 by default, medium effort, structured output, cached system prompt, fallbacks beta.
    const req = mock.anthropicRequests[0];
    expect(req).toMatchObject({ model: "claude-opus-5-5", effort: "medium", hasFormat: true, cachedSystem: true, maxTokens: 16000 });
    expect(req.betas).toContain("server-side-fallback-2026-07-01");

    const after = await one<{ n: number }>(`select count(*)::int as n from clip_candidates`);
    expect(after.n - before.n).toBe(s.found);
    // Every new candidate sits inside its recording's transcript and carries the model; the invented ones were dropped.
    const { rows: fresh } = await pool.query(
      `select c.id, c.start_sec, c.end_sec, c.score, c.hook, c.platforms, c.status, c.model,
              (select min(start_sec) from segments s where s.interaction_id = c.interaction_id) as first_sec,
              (select max(end_sec) from segments s where s.interaction_id = c.interaction_id) as last_sec
         from clip_candidates c where c.model = 'claude-opus-5-5'`,
    );
    expect(fresh.length).toBe(s.found);
    for (const c of fresh) {
      expect(c.status).toBe("new");
      expect(c.start_sec).toBeGreaterThanOrEqual(Number(c.first_sec) - 5);
      expect(c.end_sec).toBeLessThanOrEqual(Number(c.last_sec) + 30);
      expect(c.score).toBe(8);
      expect(c.platforms).toBe("tiktok,reels");
      expect(String(c.hook).length).toBeGreaterThan(0);
    }
    const scouted = await one<{ n: number }>(`select count(*)::int as n from interactions where scouted_at is not null`);
    expect(scouted.n).toBe(3);
    const ledger = await pool.query(`select provider, model, interaction_id, usd::float8 as usd from spend_ledger where provider = 'anthropic'`);
    expect(ledger.rows.length).toBe(3);
    for (const row of ledger.rows) {
      expect(row.model).toBe("claude-opus-5-5");
      expect(Number(row.usd)).toBeGreaterThan(0);
    }
  });

  it("stops at the monthly budget and says so on the recording, without calling Claude", async () => {
    const calls = mock.calls.anthropic;
    const r = await runWorker(makeCtx(makeConfig({ SCOUT_MONTHLY_BUDGET_USD: "0.0000001" })), { trigger: "test", steps: ["scout"] });
    expect(r.summary.scout).toMatchObject({ scanned: 0, waitingOnBudget: 1, stoppedEarly: "scout budget" });
    expect(mock.calls.anthropic).toBe(calls);
    const waiting = await one(`select scout_error from interactions where scouted_at is null and scout_error is not null limit 1`);
    expect(String(waiting.scout_error)).toMatch(/^waiting: anthropic monthly budget reached/);
  });

  it("treats a refusal as an empty answer and still marks the recording scouted", async () => {
    mock.setAnthropicMode("refusal");
    try {
      const r = await runWorker(makeCtx(makeConfig({ SCOUT_MAX_PER_RUN: "1" })), { trigger: "test", steps: ["scout"] });
      expect(r.summary.scout).toMatchObject({ scanned: 1, found: 0, failed: 0 });
    } finally {
      mock.setAnthropicMode("ok");
    }
    expect((await one<{ n: number }>(`select count(*)::int as n from interactions where scouted_at is not null`)).n).toBe(4);
  });

  it("stops the run when the API key is refused instead of failing every recording", async () => {
    const r = await runWorker(makeCtx(makeConfig({ ANTHROPIC_API_KEY: "wrong-key", SCOUT_MAX_PER_RUN: "5" })), { trigger: "test", steps: ["scout"] });
    expect(r.summary.scout).toMatchObject({ scanned: 0, failed: 1, stoppedEarly: "api key refused" });
    expect(r.summary.scout!.errors[0]).toMatch(/401|authentication|invalid x-api-key/i);
    const err = await one(`select scout_error from interactions where scout_error is not null and scout_error not like 'waiting:%' limit 1`);
    expect(String(err.scout_error)).toMatch(/401|authentication|invalid x-api-key/i);
  });
});

describe("cut", () => {
  let interactionId: number;
  let candidateId: number;
  let startSec: number;
  let endSec: number;

  beforeAll(async () => {
    const m = await one<{ interaction_id: number }>(`select interaction_id from media where storage = 'local' and storage_key = 'samples/sample-1.webm'`);
    interactionId = m.interaction_id;
    const seg = await one<{ start_sec: number }>(`select min(start_sec) as start_sec from segments where interaction_id = $1`, [interactionId]);
    startSec = Math.min(60, Math.max(2, Number(seg.start_sec ?? 2)));
    endSec = startSec + 20;
    const ins = await one<{ id: number }>(
      `insert into clip_candidates (interaction_id, start_sec, end_sec, score, hook, why, platforms, status, model, approved_at)
       values ($1, $2, $3, 9, 'A moment from the sample video', 'Test render', 'tiktok', 'approved', 'test', now()) returning id`,
      [interactionId, startSec, endSec],
    );
    candidateId = ins.id;
  });

  it("renders an approved candidate into a 9:16 captioned MP4 in the upload bucket and records it", async () => {
    // The seed carries four approved candidates of its own; two sit on recordings with a local sample video and render too,
    // the others have no readable source and fail with a reason. This test follows the candidate it created.
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["cut"] });
    expect(r.summary.cut!.approved).toBe(5);
    expect(r.summary.cut!.rendered).toBeGreaterThanOrEqual(1);
    expect(r.summary.cut!.errors.every((e) => /cannot read|no video original/.test(e))).toBe(true);

    const cand = await one(`select status, clip_media_id, clip_path, rendered_at, render_error from clip_candidates where id = $1`, [candidateId]);
    expect(cand.status).toBe("cut");
    expect(cand.clip_media_id).toBeTruthy();
    expect(cand.rendered_at).toBeTruthy();
    expect(cand.render_error).toBeNull();
    expect(String(cand.clip_path)).toMatch(new RegExp(`^clips/\\d{4}/\\d{2}/${candidateId}_a-moment-from-the-sample-video\\.mp4$`));

    const media = await one(`select storage, storage_key, kind, role, status, mime_type, bytes, sha256, derived_from, interaction_id from media where id = $1`, [cand.clip_media_id as number]);
    expect(media).toMatchObject({ storage: "local", kind: "video", role: "clip", status: "verified", mime_type: "video/mp4", interaction_id: interactionId });
    expect(media.storage_key).toBe(cand.clip_path);
    expect(Number(media.bytes)).toBeGreaterThan(20_000);
    expect(String(media.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(media.derived_from).toBeTruthy();

    const clip = await one(`select start_sec, end_sec, vertical, captions, source_role, bytes from clips where media_id = $1`, [cand.clip_media_id as number]);
    expect(clip).toMatchObject({ vertical: true, captions: true, source_role: "original" });
    expect(Number(clip.start_sec)).toBeCloseTo(Math.max(0, startSec - 1), 3);
    expect(Number(clip.end_sec)).toBeCloseTo(endSec + 1, 3);

    const file = path.join(STORAGE, String(cand.clip_path));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(Number(media.bytes));
    const info = probe(file);
    const video = info.streams.find((s) => s.codec_type === "video")!;
    expect(video.codec_name).toBe("h264");
    expect([video.width, video.height]).toEqual([1080, 1920]);
    expect(info.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac")).toBe(true);
    const expected = endSec + 1 - Math.max(0, startSec - 1);
    expect(Math.abs(parseFloat(info.format.duration) - expected)).toBeLessThan(0.6);
  }, 180_000);

  it("records a readable reason when there is nothing to cut from, and Try again resets it", async () => {
    // A seeded Zoom recording whose video lives only at Zoom / in B2: the local driver cannot read it.
    const i = await one<{ id: number }>(
      `select i.id from interactions i where i.source = 'zoom'
          and not exists (select 1 from media m where m.interaction_id = i.id and m.storage = 'local' and m.kind = 'video' and m.role in ('original', 'master') and m.status in ('verified', 'verified_stable'))
          and exists (select 1 from media m where m.interaction_id = i.id and m.kind = 'video' and m.role = 'original' and m.status in ('verified', 'verified_stable'))
          and not exists (select 1 from clip_candidates c where c.interaction_id = i.id and c.status = 'approved')
        order by i.id limit 1`,
    );
    const ins = await one<{ id: number }>(
      `insert into clip_candidates (interaction_id, start_sec, end_sec, score, hook, why, platforms, status, model, approved_at)
       values ($1, 30, 60, 7, 'Unreachable source', 'Test failure', 'tiktok', 'approved', 'test', now()) returning id`,
      [i.id],
    );
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["cut"] });
    expect(r.summary.cut!.failed).toBeGreaterThanOrEqual(1);
    expect(r.summary.cut!.rendered).toBe(0);
    const c = await one(`select status, render_attempts, render_error, clip_media_id from clip_candidates where id = $1`, [ins.id]);
    expect(c.status).toBe("approved");
    expect(c.render_attempts).toBe(1);
    expect(c.clip_media_id).toBeNull();
    expect(String(c.render_error)).toMatch(/cannot read|no video original/);

    const t = await buildTestApp({ DATABASE_URL: url, LOCAL_STORAGE_DIR: STORAGE });
    try {
      const s = await login(t.app);
      const res = await s.agent.post(`/api/clips/${ins.id}/rerender`).set("x-csrf-token", s.csrf);
      expect(res.status).toBe(200);
      expect(await one(`select render_attempts, render_error from clip_candidates where id = $1`, [ins.id])).toEqual({ render_attempts: 0, render_error: null });
    } finally {
      await t.close();
    }
  }, 60_000);

  describe("clips API", () => {
    let t: TestApp;
    let s: Session;
    beforeAll(async () => {
      t = await buildTestApp({ DATABASE_URL: url, LOCAL_STORAGE_DIR: STORAGE });
      s = await login(t.app);
    });
    afterAll(() => t.close());

    it("lists candidates by status with counts, approves with a timestamp, and hands out a download URL for rendered clips", async () => {
      expect((await request(t.app).get("/api/clips")).status).toBe(401);

      const toReview = await s.agent.get("/api/clips?status=new");
      expect(toReview.status).toBe(200);
      const items = toReview.body.items as Array<{ id: number; score: number; title: string | null; interactionId: number; platforms: string[]; status: string }>;
      expect(items.length).toBeGreaterThan(0);
      for (let i = 1; i < items.length; i++) expect(items[i - 1].score).toBeGreaterThanOrEqual(items[i].score);
      expect(items[0].status).toBe("new");
      expect(toReview.body.counts.new).toBe(items.length);
      expect(toReview.body.counts.cut).toBeGreaterThanOrEqual(1);

      const approve = await s.agent.patch(`/api/clips/${items[0].id}`).set("x-csrf-token", s.csrf).send({ status: "approved" });
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe("approved");
      const approvedRow = await one(`select approved_at from clip_candidates where id = $1`, [items[0].id]);
      expect(approvedRow.approved_at).toBeTruthy();
      const approvedList = await s.agent.get("/api/clips?status=approved");
      expect((approvedList.body.items as Array<{ id: number }>).some((c) => c.id === items[0].id)).toBe(true);

      const cut = await s.agent.get("/api/clips?status=cut");
      const rendered = (cut.body.items as Array<{ id: number; clipMediaId: number | null; clipBytes: number | null; renderedAt: string | null }>).find((c) => c.id === candidateId)!;
      expect(rendered.clipMediaId).toBeTruthy();
      expect(rendered.clipBytes).toBeGreaterThan(20_000);
      expect(rendered.renderedAt).toBeTruthy();

      // A cut clip cannot be moved back.
      expect((await s.agent.patch(`/api/clips/${candidateId}`).set("x-csrf-token", s.csrf).send({ status: "new" })).status).toBe(404);

      const dl = await s.agent.get(`/api/clips/${candidateId}/download`);
      expect(dl.status).toBe(200);
      expect(dl.body.filename).toMatch(/\.mp4$/);
      expect(dl.body.bytes).toBeGreaterThan(20_000);
      const file = await s.agent.get(dl.body.url).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(file.status).toBe(200);
      expect((file.body as Buffer).length).toBe(dl.body.bytes);
      // Not rendered yet -> no download.
      expect((await s.agent.get(`/api/clips/${items[0].id}/download`)).status).toBe(404);

      // The recording page knows which candidates are downloadable.
      const detail = await s.agent.get(`/api/interactions/${interactionId}`);
      expect(detail.status).toBe(200);
      const mine = (detail.body.clips as Array<{ id: number; clipMediaId: number | null; status: string }>).find((c) => c.id === candidateId)!;
      expect(mine).toMatchObject({ status: "cut" });
      expect(mine.clipMediaId).toBeTruthy();

      // The pipeline report counts clips and Claude spend.
      const pipeline = await s.agent.get("/api/pipeline");
      expect(pipeline.body.report.clips.cut).toBeGreaterThanOrEqual(1);
      expect(pipeline.body.report.spend.anthropicUsd).toBeGreaterThan(0);
      expect(pipeline.body.config).toMatchObject({ scoutModel: "claude-opus-5-5", clipFormat: "vertical" });
    });
  });
});
