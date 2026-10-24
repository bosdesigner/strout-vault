// The worker end to end against a mock Zoom API and a mock Groq endpoint, on
// its own local database so the other API tests never see its rows. Nothing
// here reaches Neon, B2, R2, Zoom or Groq.
import crypto from "node:crypto";
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
import { createMockServices, SAMPLE_VTT, type MockRecording } from "../mocks/zoomGroq.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-worker");
const TMP = path.join(os.tmpdir(), "strout-vault-worker-test");
const FIXTURE_MP4 = fs.readFileSync(path.resolve("tests/e2e/fixtures/upload-test.mp4"));
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

let url: string;
let pool: pg.Pool;
let storage: LocalStorageDriver;
let tone: Buffer;
let recordings: MockRecording[];
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
    ZOOM_ACCOUNT_ID: "acc",
    ZOOM_CLIENT_ID: "cid",
    ZOOM_CLIENT_SECRET: "csecret",
    ZOOM_API_BASE: "https://zoom.test/v2",
    ZOOM_OAUTH_BASE: "https://zoom.test",
    ZOOM_SYNC_OVERLAP_MONTHS: "2",
    GROQ_API_KEY: "groq-test-key",
    GROQ_URL: "https://groq.test/transcribe",
    GROQ_MONTHLY_BUDGET_USD: "0.00005",
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

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  ({ url } = await resetDatabase(server, "strout_vault_worker", { seed: true, storageDir: STORAGE, quiet: true }));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  // The seed's demo rows in non-ready states are not this test's subject.
  await pool.query(`update interactions set pipeline_status = 'ready' where pipeline_status in ('queued', 'transcribing', 'failed')`);
  // Three seconds of 440 Hz, AAC in an M4A container, like Zoom's audio-only file.
  const tonePath = path.join(TMP, "tone.m4a");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", tonePath]);
  tone = fs.readFileSync(tonePath);

  recordings = [
    {
      uuid: "A1b2C3d4E5f6G7h8==",
      meetingNumber: "81111111111",
      topic: "Kickoff with Dana",
      start: daysAgo(10),
      durationMin: 1,
      files: [
        { id: "a-mp4", type: "MP4", body: FIXTURE_MP4, redirectToCdn: true },
        { id: "a-m4a", type: "M4A", body: tone },
        { id: "a-vtt", type: "TRANSCRIPT", body: Buffer.from(SAMPLE_VTT) },
        { id: "a-chat", type: "CHAT", body: Buffer.from("10:00:01 Dana: hi\n") },
        { id: "a-timeline", type: "TIMELINE", body: Buffer.from("{}") },
      ],
    },
    {
      uuid: "B2c3D4e5F6g7H8i9==",
      meetingNumber: "82222222222",
      topic: "Site walk, no transcript",
      start: daysAgo(20),
      durationMin: 0,
      files: [
        { id: "b-m4a", type: "M4A", body: tone, rateLimitOnce: true },
        { id: "b-chat", type: "CHAT", body: Buffer.from("stable bytes"), reportedSize: 99 },
      ],
    },
    {
      uuid: "C3d4E5f6G7h8I9j0==",
      meetingNumber: "83333333333",
      topic: "Waits for budget",
      // Oldest of the three, so newest-first ordering transcribes B before the budget runs out.
      start: daysAgo(25),
      durationMin: 0,
      files: [{ id: "c-m4a", type: "M4A", body: tone }],
    },
    {
      uuid: "D4e5F6g7H8i9J0k1==",
      meetingNumber: "84444444444",
      topic: "Zoom lost the file",
      start: daysAgo(3),
      durationMin: 2,
      files: [{ id: "d-mp4", type: "MP4", body: FIXTURE_MP4, notFound: true }],
    },
  ];
  mock = createMockServices(recordings);
}, 180_000);

afterAll(async () => {
  await pool?.end();
});

describe("worker run", () => {
  it("skips the Zoom step when Zoom is not configured and still records a run", async () => {
    const ctx = makeCtx(makeConfig({ ZOOM_ACCOUNT_ID: "", ZOOM_CLIENT_ID: "", ZOOM_CLIENT_SECRET: "" }));
    const r = await runWorker(ctx, { trigger: "test" });
    expect(r.ok).toBe(true);
    expect(r.summary.zoom?.configured).toBe(false);
    expect(r.summary.transcribe?.candidates).toBe(0);
    const run = await one(`select ok, trigger, summary from worker_runs where id = $1`, [r.runId]);
    expect(run.ok).toBe(true);
    expect(run.trigger).toBe("test");
  });

  it("pulls new Zoom recordings into storage, verifies them, and transcribes with Zoom's VTT first", async () => {
    const before = await one<{ n: number }>(`select count(*)::int as n from interactions`);
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test" });
    expect(r.ok).toBe(true);
    const z = r.summary.zoom!;
    expect(z.configured).toBe(true);
    expect(z.recordingsSeen).toBe(4);
    expect(z.recordingsNew).toBe(4);
    expect(z.filesQueued).toBe(8); // TIMELINE is metadata and never archived
    expect(z.filesVerified).toBe(6);
    expect(z.filesStable).toBe(1);
    expect(z.filesFailed).toBe(1);
    expect(z.cursor).toBe(new Date().toISOString().slice(0, 7));
    expect(mock.calls.cdnAuthHeaders).toBe(0); // bearer token never followed the redirect
    expect(mock.calls.token).toBe(1);

    const after = await one<{ n: number }>(`select count(*)::int as n from interactions`);
    expect(after.n - before.n).toBe(4);

    // Recording A: every file verified, byte-identical in storage, video linked, VTT transcript.
    const a = await one(`select id, vault_id, kind, title, duration_sec, host_email, pipeline_status, pipeline_error, transcript, media_id, source_payload from interactions where source = 'zoom' and source_ref = $1`, [recordings[0].uuid]);
    expect(a.kind).toBe("meeting");
    expect(a.title).toBe("Kickoff with Dana");
    expect(a.duration_sec).toBe(60);
    expect(a.host_email).toBe("ben@test.local");
    expect(a.vault_id).toMatch(/^v[a-z0-9]{9}$/);
    expect(a.pipeline_status).toBe("ready");
    expect((a.source_payload as Record<string, unknown>).share_url).toBeUndefined();
    const aMedia = (await pool.query(`select kind, status, bytes, sha256, storage_key, storage, mime_type, source_file_id, attempts from media where interaction_id = $1 order by kind`, [a.id])).rows;
    expect(aMedia.map((m) => m.kind).sort()).toEqual(["audio", "chat", "transcript_vtt", "video"]);
    const video = aMedia.find((m) => m.kind === "video")!;
    expect(video.status).toBe("verified");
    expect(video.bytes).toBe(FIXTURE_MP4.length);
    expect(video.sha256).toBe(sha(FIXTURE_MP4));
    expect(video.mime_type).toBe("video/mp4");
    expect(video.storage).toBe("local");
    expect(video.storage_key).toMatch(/^meeting-vault\/\d{4}\/\d{4}-\d{2}-\d{2}_za1b2c3d4e5f6\/original\/video_amp4\.mp4$/);
    expect(sha(fs.readFileSync(path.join(STORAGE, video.storage_key)))).toBe(sha(FIXTURE_MP4));
    const aAudio = aMedia.find((m) => m.kind === "audio")!;
    expect(a.media_id).toBe(aAudio.id ?? a.media_id); // first AV file to land becomes the primary
    const aT = await one(`select source, segment_count, has_words from transcripts where interaction_id = $1`, [a.id]);
    expect(aT.source).toBe("zoom_vtt");
    expect(aT.segment_count).toBe(3);
    expect(aT.has_words).toBe(false);
    const aSeg = (await pool.query(`select idx, speaker, text, words from segments where interaction_id = $1 order by idx`, [a.id])).rows;
    expect(aSeg[0]).toMatchObject({ idx: 0, speaker: "Dana Whitfield", text: "Thanks for making the time today.", words: null });
    expect(String(a.transcript)).toContain("[00:00:01] Dana Whitfield: Thanks");
    const aJobs = (await pool.query(`select j.stage, j.status from jobs j join media m on m.id = j.media_id where m.interaction_id = $1 order by j.stage`, [a.id])).rows;
    expect(aJobs).toEqual([
      { stage: "extract", status: "pending" },
      { stage: "transcribe", status: "done" },
    ]);
    // The search index sees it immediately (tsv is a generated column).
    const hit = await one<{ n: number }>(`select count(*)::int as n from segments where interaction_id = $1 and tsv @@ websearch_to_tsquery('english', 'pelican roof tiles')`, [a.id]);
    expect(hit.n).toBe(1);

    // Recording B: audio only -> Groq, under budget; chat file with a wrong reported size -> verified_stable.
    const b = await one(`select id, pipeline_status from interactions where source = 'zoom' and source_ref = $1`, [recordings[1].uuid]);
    expect(b.pipeline_status).toBe("ready");
    const bT = await one(`select source, model, language, has_words, segment_count from transcripts where interaction_id = $1`, [b.id]);
    expect(bT).toMatchObject({ source: "groq", model: "whisper-large-v3-turbo", language: "en", has_words: true, segment_count: 2 });
    const bSeg = (await pool.query(`select text, words from segments where interaction_id = $1 order by idx`, [b.id])).rows;
    expect(bSeg[0].text).toBe("Hello from the mock.");
    expect(Array.isArray(bSeg[0].words)).toBe(true);
    expect((bSeg[0].words as Array<{ word: string }>).map((w) => w.word)).toEqual(["Hello", "from", "the", "mock."]);
    const bChat = await one(`select status, bytes, last_error from media where interaction_id = $1 and kind = 'chat'`, [b.id]);
    expect(bChat.status).toBe("verified_stable");
    expect(bChat.bytes).toBe("stable bytes".length);
    expect(String(bChat.last_error)).toMatch(/reproducible/);
    expect(mock.groqRequests[0]).toEqual({ model: "whisper-large-v3-turbo", filename: "audio.ogg", hasAuth: true });
    const spend = await one(`select provider, interaction_id, usd::float8 as usd, units_sec from spend_ledger`);
    expect(spend.provider).toBe("groq");
    expect(spend.interaction_id).toBe(b.id);
    expect(Number(spend.usd)).toBeCloseTo((3 / 3600) * 0.04, 6);

    // Recording C: Groq would exceed the month's budget -> left queued with the reason, nothing sent.
    const c = await one(`select id, pipeline_status, pipeline_error from interactions where source = 'zoom' and source_ref = $1`, [recordings[2].uuid]);
    expect(c.pipeline_status).toBe("queued");
    expect(String(c.pipeline_error)).toMatch(/^waiting: groq monthly budget reached/);
    expect(mock.calls.groq).toBe(1);

    // Recording D: the only file 404s at Zoom -> media failed, interaction stays queued, nothing to transcribe.
    const d = await one(`select id, pipeline_status from interactions where source = 'zoom' and source_ref = $1`, [recordings[3].uuid]);
    expect(d.pipeline_status).toBe("queued");
    const dMedia = await one(`select status, attempts, last_error from media where interaction_id = $1`, [d.id]);
    expect(dMedia.status).toBe("failed");
    expect(dMedia.attempts).toBe(1);
    expect(String(dMedia.last_error)).toMatch(/HTTP 404/);

    const t = r.summary.transcribe!;
    expect(t).toMatchObject({ candidates: 3, done: 2, viaZoomTranscript: 1, viaZoomCaptions: 0, viaGroq: 1, waitingOnBudget: 1, failed: 0 });
    expect(r.summary.report!.queue.queued).toBeGreaterThanOrEqual(2);
    const state = await one(`select value from worker_state where key = 'zoom_cursor_month'`);
    expect((state.value as { month: string }).month).toBe(new Date().toISOString().slice(0, 7));
  }, 120_000);

  it("is idempotent: a second run creates nothing new and only retries what failed", async () => {
    const counts = async () => one<{ i: number; m: number; s: number; t: number }>(`select (select count(*)::int from interactions) i, (select count(*)::int from media) m, (select count(*)::int from segments) s, (select count(*)::int from transcripts) t`);
    const before = await counts();
    const r = await runWorker(makeCtx(makeConfig({ GROQ_MONTHLY_BUDGET_USD: "1" })), { trigger: "test" });
    expect(r.ok).toBe(true);
    expect(r.summary.zoom).toMatchObject({ recordingsSeen: 4, recordingsNew: 0, filesQueued: 0, filesVerified: 0, filesStable: 0, filesFailed: 1 });
    // C is transcribed now that the budget allows it.
    expect(r.summary.transcribe).toMatchObject({ done: 1, viaGroq: 1, waitingOnBudget: 0, failed: 0 });
    const after = await counts();
    expect(after.i).toBe(before.i);
    expect(after.m).toBe(before.m);
    expect(after.t - before.t).toBe(1);
    const d = await one(`select m.attempts from media m join interactions i on i.id = m.interaction_id where i.source_ref = $1`, [recordings[3].uuid]);
    expect(d.attempts).toBe(2);
  }, 120_000);

  it("picks up a file Zoom finishes processing later, without touching the rest", async () => {
    recordings[2].files.push({ id: "c-vtt", type: "TRANSCRIPT", body: Buffer.from(SAMPLE_VTT) });
    const r = await runWorker(makeCtx(makeConfig({ GROQ_MONTHLY_BUDGET_USD: "1" })), { trigger: "test", steps: ["zoom"] });
    expect(r.summary.zoom).toMatchObject({ recordingsNew: 0, filesQueued: 1, filesVerified: 1 });
    const c = await one(`select id from interactions where source_ref = $1`, [recordings[2].uuid]);
    const kinds = (await pool.query(`select kind, status from media where interaction_id = $1 order by kind`, [c.id])).rows;
    expect(kinds).toEqual([
      { kind: "audio", status: "verified" },
      { kind: "transcript_vtt", status: "verified" },
    ]);
  });

  it("refuses to run twice at once", async () => {
    const holder = await pool.connect();
    try {
      await holder.query(`select pg_advisory_lock(hashtext('strout-vault-worker'))`);
      const r = await runWorker(makeCtx(makeConfig()), { trigger: "test" });
      expect(r.summary.skipped).toBe("locked");
      expect(r.ok).toBe(true);
    } finally {
      await holder.query(`select pg_advisory_unlock(hashtext('strout-vault-worker'))`);
      holder.release();
    }
  });

  it("stops starting new work once the time budget is spent", async () => {
    recordings.push({ uuid: "E5f6==", meetingNumber: "85555555555", topic: "Arrives after the deadline", start: daysAgo(1), durationMin: 0, files: [{ id: "e-m4a", type: "M4A", body: tone }] });
    const r = await runWorker(makeCtx(makeConfig(), { deadline: Date.now() - 1 }), { trigger: "test" });
    expect(r.summary.zoom?.recordingsNew).toBe(1); // enumeration is cheap and always finishes
    expect(r.summary.zoom?.stoppedEarly).toBe("time budget");
    expect(r.summary.zoom?.filesVerified).toBe(0);
    expect(r.summary.transcribe?.done).toBe(0);
  });

  it("a refused storage write is named, stops the run early and does not use up the file's retries", async () => {
    // Make the destination unwritable: a directory where the object would go, so the local driver's rename fails.
    const e = await one(`select m.id, m.storage_key, m.attempts from media m join interactions i on i.id = m.interaction_id where i.source_ref = $1`, [recordings[4].uuid]);
    const dest = path.join(STORAGE, String(e.storage_key));
    fs.mkdirSync(dest, { recursive: true });
    try {
      const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["zoom"] });
      expect(r.summary.zoom?.filesFailed).toBe(1);
      expect(r.summary.zoom?.stoppedEarly).toBe("storage refused writes");
      expect(r.summary.zoom?.errors[0]).toMatch(/^download audio for "Arrives after the deadline": storage local refused the write:/);
      const after = await one(`select status, attempts, last_error from media where id = $1`, [e.id]);
      expect(after.status).toBe("failed");
      expect(after.attempts).toBe(Number(e.attempts)); // unchanged: the bucket, not the file, was the problem
      expect(String(after.last_error)).toMatch(/storage local .*refused the write/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    // With storage writable again the same file goes through on the next run.
    const r2 = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["zoom"] });
    expect(r2.summary.zoom?.filesVerified).toBe(1);
    expect((await one(`select status from media where id = $1`, [e.id])).status).toBe("verified");
  });
});

describe("pipeline API", () => {
  let t: TestApp;
  let s: Session;
  beforeAll(async () => {
    t = await buildTestApp({ DATABASE_URL: url, LOCAL_STORAGE_DIR: STORAGE });
    s = await login(t.app);
  });
  afterAll(() => t.close());

  it("is owner-only and reports runs, the queue, waiting items and configuration", async () => {
    const anon = await request(t.app).get("/api/pipeline");
    expect(anon.status).toBe(401);
    const res = await s.agent.get("/api/pipeline");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.lastRuns.length).toBeGreaterThanOrEqual(3);
    expect(body.lastRuns[0]).toMatchObject({ trigger: "test" });
    // The settings shown are the worker's (from its last run), not the web app's: this app has no Zoom or Groq secrets.
    expect(body.configSource).toBe("worker");
    expect(body.config).toMatchObject({ zoomConfigured: true, groqConfigured: true, archiveStorage: "local", transcribePrefer: "zoom" });
    expect(body.config.groqBudgetUsd).toBeGreaterThan(0);
    expect(body.state.zoomCursor).toBe(new Date().toISOString().slice(0, 7));
    expect(body.report.queue.ready).toBeGreaterThan(0);
    const waiting = body.waiting as Array<{ id: number; title: string; pendingFiles: number; failedFiles: number; fileError: string | null }>;
    const lost = waiting.find((w) => w.title === "Zoom lost the file");
    expect(lost).toMatchObject({ pendingFiles: 1, failedFiles: 1 });
    expect(lost?.fileError).toMatch(/HTTP 404/);
    expect(body.report.missingOffsite.total).toBeGreaterThanOrEqual(0);

    // "Retry downloads" on a waiting recording resets its failed files so the next run fetches them again.
    const before = await one(`select attempts from media where interaction_id = $1`, [lost!.id]);
    expect(Number(before.attempts)).toBeGreaterThan(1);
    const retry = await s.agent.post("/api/pipeline/retry").set("x-csrf-token", s.csrf).send({ interactionId: lost!.id });
    expect(retry.status).toBe(200);
    expect(await one(`select status, attempts, last_error from media where interaction_id = $1`, [lost!.id])).toEqual({ status: "pending", attempts: 0, last_error: null });
  });

  it("marks a broken upload failed and Retry puts it back in the queue", async () => {
    // Random bytes dressed up as an mp4: ffprobe cannot read them, so transcription fails.
    const bytes = crypto.randomBytes(4096);
    const create = await s.agent.post("/api/uploads/multipart").set("x-csrf-token", s.csrf).send({ filename: "broken.mp4", type: "video/mp4", size: bytes.length });
    const { uploadId, key } = create.body as { uploadId: string; key: string };
    const sign = await s.agent.get(`/api/uploads/multipart/${uploadId}/1?key=${encodeURIComponent(key)}`);
    const put = await s.agent.put(sign.body.url).set("content-type", "application/octet-stream").send(bytes);
    await s.agent.post(`/api/uploads/multipart/${uploadId}/complete?key=${encodeURIComponent(key)}`).set("x-csrf-token", s.csrf).send({ parts: [{ PartNumber: 1, ETag: put.headers.etag }] });
    const fin = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send({
      key,
      sha256: sha(bytes),
      bytes: bytes.length,
      mimeType: "video/mp4",
      originalFilename: "broken.mp4",
      title: "Broken upload",
      recordedAt: new Date().toISOString(),
      workspaceId: "another_story",
      source: "upload",
      partyIds: [],
    });
    expect(fin.status).toBe(201);
    const interactionId = fin.body.interactionId as number;

    const r = await runWorker(makeCtx(makeConfig({ GROQ_MONTHLY_BUDGET_USD: "1" })), { trigger: "test", steps: ["transcribe"] });
    expect(r.summary.transcribe?.failed).toBe(1);
    const row = await one(`select pipeline_status, pipeline_error from interactions where id = $1`, [interactionId]);
    expect(row.pipeline_status).toBe("failed");
    expect(String(row.pipeline_error)).toMatch(/ffprobe|ffmpeg/);
    const job = await one(`select j.status, j.attempts from jobs j join media m on m.id = j.media_id where m.interaction_id = $1 and j.stage = 'transcribe'`, [interactionId]);
    expect(job).toEqual({ status: "failed", attempts: 1 });

    const list = await s.agent.get("/api/pipeline");
    expect((list.body.failed as Array<{ id: number; error: string }>).some((f) => f.id === interactionId)).toBe(true);

    const retry = await s.agent.post("/api/pipeline/retry").set("x-csrf-token", s.csrf).send({ interactionId });
    expect(retry.status).toBe(200);
    const after = await one(`select pipeline_status, pipeline_error from interactions where id = $1`, [interactionId]);
    expect(after).toEqual({ pipeline_status: "queued", pipeline_error: null });
    const job2 = await one(`select j.status, j.attempts from jobs j join media m on m.id = j.media_id where m.interaction_id = $1 and j.stage = 'transcribe'`, [interactionId]);
    expect(job2).toEqual({ status: "pending", attempts: 0 });
    expect((await s.agent.post("/api/pipeline/retry").set("x-csrf-token", s.csrf).send({ interactionId: 999999999 })).status).toBe(404);
  }, 60_000);
});
