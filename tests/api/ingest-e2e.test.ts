// Every new ingest point end to end on one local database, with nothing reaching Google, Groq,
// R2 or Neon: the real Mac media collector process (fixture Voice Memos + Notes) posting to a
// running vault, a Google Meet account connected through the OAuth callback (a broader grant is
// refused) and synced from a fake Drive + Calendar (a second account with no recordings is marked
// once and left alone), then the worker's transcribe step (Groq mocked for the audio, Meet's own
// transcript Doc for the meeting) and the embed step. The rows it ends with are the ones in
// docs/ingest-verification (VERIFY_OUT=docs/ingest-verification writes them).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { buildAppleFixtures, SQLITE_AVAILABLE, type AppleFixture } from "../fixtures/apple-media/build.ts";
import { runWorker } from "../../server/worker/run.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { makeState } from "../../server/routes/messages.ts";
import { parseMeetTranscript, meetBaseName } from "../../server/meet/transcript.ts";
import { checkMeetScopes, DRIVE_MEET_READONLY_SCOPE, CALENDAR_EVENTS_READONLY_SCOPE } from "../../server/meet/api.ts";

const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-ingest");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-ingest-"));
const KEY = "cd".repeat(32);
const VERIFY_OUT = process.env.VERIFY_OUT ? path.resolve(REPO_ROOT, process.env.VERIFY_OUT) : null;

let t: TestApp;
let http: Server;
let pool: pg.Pool;
let owner: Session;
let macToken = "";
let fx: AppleFixture;
let meetVideo: Buffer;
const csrf = () => ({ "x-csrf-token": owner.csrf });

const TRANSCRIPT_DOC = `Conroe shoot planning - Transcript
Attendees
Ben Strout, Kevin McGuire
Transcript
00:00:00
Ben Strout: Morning Kevin. Are we still on for the Conroe shoot?
Kevin McGuire: Yes. Sunrise, so the drone pass happens before the wind picks up.
00:00:04
Ben Strout: Good. Day rate stays at fifteen hundred plus mileage.
Kevin McGuire: Agreed.
This editable transcript was computer generated and might contain errors.`;

// ------------------------------------------------------------- fake Google + Groq --
const google = { calls: [] as string[], groq: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const MEET_SCOPE = `${DRIVE_MEET_READONLY_SCOPE} ${CALENDAR_EVENTS_READONLY_SCOPE}`;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  if (url.host === "groq.test") {
    google.groq++;
    return json({ text: "fixture", language: "en", duration: 6, segments: [{ start: 0, end: 3, text: "This is the fixture transcript of a recording." }, { start: 3, end: 6, text: "It came back from the mocked Groq endpoint." }] });
  }
  if (url.host !== "google.test") throw new Error(`unexpected fetch to ${url.host}`);
  google.calls.push(`${url.pathname}${url.searchParams.get("q") ? `?q=${url.searchParams.get("q")}` : ""}`);
  if (url.pathname === "/token") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "authorization_code") {
      const code = body.get("code");
      if (code === "broad-code") return json({ access_token: "ya29.broad", refresh_token: "1//broad", scope: `${DRIVE_MEET_READONLY_SCOPE} https://www.googleapis.com/auth/drive.readonly` });
      if (code === "meet-code") return json({ access_token: "ya29.ben", refresh_token: "1//meet-ben", scope: MEET_SCOPE });
      if (code === "empty-code") return json({ access_token: "ya29.empty", refresh_token: "1//meet-empty", scope: DRIVE_MEET_READONLY_SCOPE });
      return json({ error: "invalid_grant" }, 400);
    }
    const rt = body.get("refresh_token");
    if (rt === "1//meet-ben") return json({ access_token: "ya29.ben", expires_in: 3600, scope: MEET_SCOPE });
    if (rt === "1//meet-empty") return json({ access_token: "ya29.empty", expires_in: 3600, scope: DRIVE_MEET_READONLY_SCOPE });
    return json({ error: "invalid_grant" }, 400);
  }
  const who = auth === "Bearer ya29.ben" ? "ben" : auth === "Bearer ya29.empty" ? "empty" : null;
  if (!who) return json({ error: "unauthenticated" }, 401);
  if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: who === "ben" ? "ben@example.com" : "ops@example.com" } });
  if (url.pathname === "/drive/v3/files") {
    const q = url.searchParams.get("q") ?? "";
    if (who === "empty") return json({ files: [] });
    if (q.includes("video/mp4")) {
      return json({ files: [{ id: "drive-rec-0001", name: "Conroe shoot planning (2026-10-22 09:00 GMT-5)", mimeType: "video/mp4", size: String(meetVideo.length), createdTime: "2026-10-22T14:30:00Z", videoMediaMetadata: { durationMillis: "8000" } }] });
    }
    if (q.includes("google-apps.document")) {
      return json({ files: [{ id: "drive-doc-0001", name: "Conroe shoot planning (2026-10-22 09:00 GMT-5) - Transcript", mimeType: "application/vnd.google-apps.document", createdTime: "2026-10-22T14:31:00Z" }] });
    }
    return json({ files: [] });
  }
  if (url.pathname === "/drive/v3/files/drive-rec-0001" && url.searchParams.get("alt") === "media") return new Response(new Uint8Array(meetVideo), { status: 200, headers: { "content-length": String(meetVideo.length) } });
  if (url.pathname === "/drive/v3/files/drive-doc-0001/export") return new Response(TRANSCRIPT_DOC, { status: 200 });
  if (url.pathname === "/calendar/v3/calendars/primary/events") {
    return json({ items: [{ id: "evt-1", summary: "Conroe shoot planning", hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: [{ email: "ben@example.com", self: true }, { email: "Kevin.McGuire@example.com", displayName: "Kevin McGuire" }, { email: "room-1@resource.calendar.google.com", resource: true }] }] });
  }
  return json({ error: "not_found", path: url.pathname }, 404);
}) as typeof fetch;

function ctx(extra: Partial<WorkerContext> = {}): WorkerContext {
  return {
    config: t.config,
    pool,
    storage: t.storage,
    fetchImpl: fakeFetch,
    sleep: async () => {},
    now: () => new Date("2026-10-23T12:00:00Z"),
    log: () => {},
    tmpDir: path.join(tmp, "work"),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    deadline: Date.now() + 10 * 60_000,
    bytesBudget: 1e12,
    ...extra,
  };
}

/** Runs the real collector as a child process (async: this process is also the vault it posts to). */
function collector(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "collectors/apple-media/collector.mjs"), "--voice-memos", fx.voiceMemosDir, "--notes", fx.notesDir, "--state", path.join(tmp, "state.json"), "--log-file", path.join(tmp, "collector.log"), "--config", path.join(tmp, "none.json"), ...args], {
      env: { ...process.env, STROUT_VAULT_URL: BASE, STROUT_VAULT_TOKEN: macToken },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const sums = () => Object.fromEntries(fx.files.map((f) => [path.relative(fx.root, f), crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const urls = await resetDatabase(server, "strout_vault_ingest", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  fs.mkdirSync(path.join(tmp, "work"), { recursive: true });
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "message_routing.yml"), `apple_notes_folders:\n  Another Story: another_story\n`);
  await pool.query(`update parties set phones = array['214-555-0166'] where id = 6`);
  const video = path.join(tmp, "meet.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:d=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  meetVideo = fs.readFileSync(video);
  t = await buildTestApp(
    {
      DATABASE_URL: urls.url,
      LOCAL_STORAGE_DIR: STORAGE,
      PUBLIC_URL: BASE,
      MCP_READER_DATABASE_URL: urls.readerUrl,
      MCP_PROPOSER_DATABASE_URL: urls.proposerUrl,
      LOGIN_RATE_LIMIT_MAX: "200",
      OWNER_EMAILS: "ben@example.com",
      OWNER_PHONES: "+1 713 555 0100",
      OWNER_NAME: "Ben Strout",
      MESSAGES_CONFIG_DIR: configDir,
      MESSAGES_ENCRYPTION_KEY: KEY,
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-secret",
      GOOGLE_OAUTH_AUTHORIZE_URL: "http://google.test/auth",
      GOOGLE_OAUTH_TOKEN_URL: "http://google.test/token",
      DRIVE_API_BASE: "http://google.test/drive/v3",
      CALENDAR_API_BASE: "http://google.test/calendar/v3",
      GROQ_API_KEY: "groq-test",
      GROQ_URL: "http://groq.test/openai/v1/audio/transcriptions",
      GROQ_MONTHLY_BUDGET_USD: "5",
      EMBEDDING_PROVIDER: "fake",
    },
    { fetchImpl: fakeFetch },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
  const mint = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "Mac media collector", workspaceScope: [], scopes: ["ingest:device"], purpose: "mac_media" });
  expect(mint.status, mint.text).toBe(201);
  macToken = mint.body.token;
});

afterAll(async () => {
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  await pool?.end();
  await t?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Meet transcript parsing and scopes", () => {
  it("turns the Doc into timed, speaker-labelled segments and ignores the header and footer", () => {
    const p = parseMeetTranscript(TRANSCRIPT_DOC, 8);
    expect(p.attendees).toEqual(["Ben Strout", "Kevin McGuire"]);
    expect(p.speakers).toEqual(["Ben Strout", "Kevin McGuire"]);
    expect(p.segments).toHaveLength(4);
    expect(p.segments[0]).toMatchObject({ start: 0, speaker: "Ben Strout" });
    expect(p.segments[2].start).toBe(4);
    expect(p.segments.every((s, i) => i === 0 || s.start >= p.segments[i - 1].start)).toBe(true);
    expect(p.segments.map((s) => s.text).join(" ")).not.toContain("computer generated");
    expect(meetBaseName("Conroe shoot planning (2026-10-22 09:00 GMT-5) - Transcript")).toBe(meetBaseName("Conroe shoot planning (2026-10-22 09:00 GMT-5)"));
  });

  it("accepts drive.meet.readonly (+ calendar.events.readonly), refuses anything broader", () => {
    expect(checkMeetScopes([DRIVE_MEET_READONLY_SCOPE])).toBeNull();
    expect(checkMeetScopes([DRIVE_MEET_READONLY_SCOPE, CALENDAR_EVENTS_READONLY_SCOPE, "openid", "email"])).toBeNull();
    expect(checkMeetScopes([DRIVE_MEET_READONLY_SCOPE, "https://www.googleapis.com/auth/drive.readonly"])).toMatch(/more than/);
    expect(checkMeetScopes(["https://www.googleapis.com/auth/gmail.readonly"])).toMatch(/does not include/);
  });
});

describe("connecting Google Meet accounts", () => {
  it("asks Google for drive.meet.readonly only (plus calendar on request)", async () => {
    const r = await owner.agent.get("/api/messages/meet/connect?calendar=1");
    expect(r.status).toBe(302);
    const u = new URL(r.headers.location);
    expect(u.searchParams.get("scope")).toBe(MEET_SCOPE);
    expect(u.searchParams.get("redirect_uri")).toBe(`${BASE}/api/messages/meet/callback`);
    const plain = new URL((await owner.agent.get("/api/messages/meet/connect")).headers.location);
    expect(plain.searchParams.get("scope")).toBe(DRIVE_MEET_READONLY_SCOPE);
  });

  it("refuses a broader grant and a Gmail state, stores a good one encrypted", async () => {
    const state = makeState(t.config.SESSION_SECRET, "owner@test.local", Date.now(), "meet");
    const broad = await owner.agent.get(`/api/messages/meet/callback?state=${encodeURIComponent(state)}&code=broad-code`);
    expect(broad.status).toBe(400);
    expect(broad.text).toMatch(/more than drive\.meet\.readonly/);
    const gmailState = makeState(t.config.SESSION_SECRET, "owner@test.local", Date.now(), "gmail");
    expect((await owner.agent.get(`/api/messages/meet/callback?state=${encodeURIComponent(gmailState)}&code=meet-code`)).status).toBe(400);
    const ok = await owner.agent.get(`/api/messages/meet/callback?state=${encodeURIComponent(state)}&code=meet-code`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).toContain("Connected ben@example.com for Google Meet");
    const empty = await owner.agent.get(`/api/messages/meet/callback?state=${encodeURIComponent(state)}&code=empty-code`);
    expect(empty.status).toBe(200);
    const rows = (await pool.query(`select provider, account_email, scope, refresh_token_enc from message_accounts order by id`)).rows;
    expect(rows.map((r) => [r.provider, r.account_email])).toEqual([["meet", "ben@example.com"], ["meet", "ops@example.com"]]);
    expect(rows[0].scope).toBe(MEET_SCOPE);
    expect(rows[0].refresh_token_enc).toMatch(/^v1:/);
    expect(JSON.stringify(rows)).not.toContain("1//meet-ben");
  });
});

describe.skipIf(!SQLITE_AVAILABLE)("end to end: one voice memo, two call recordings, notes, one Meet recording", () => {
  let before: Record<string, string>;

  it("the Mac collector sends the fixtures (backfill) and the Apple files stay unchanged", async () => {
    fx = buildAppleFixtures(path.join(tmp, "apple"));
    before = sums();
    const dry = await collector(["--backfill", "--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(fs.existsSync(path.join(tmp, "state.json"))).toBe(false);
    const run = await collector(["--backfill"]);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stdout).toMatch(/done \(run \d+\): voice_memo created 1; iphone_call created 3; apple_note created 2/);
    for (const secret of ["drone pass", "Porch idea", "Woodlands porch", "cypress"]) {
      expect(run.stdout).not.toContain(secret);
      expect(fs.readFileSync(path.join(tmp, "collector.log"), "utf8")).not.toContain(secret);
    }
    expect(sums()).toEqual(before);
  });

  it("a second run sends nothing; a run with a lost state file finds everything already in the vault", async () => {
    const again = await collector([]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout, again.stdout).toMatch(/voice_memo none; iphone_call none; apple_note none; already sent voice_memo 1, iphone_call 3, apple_note 2/);
    fs.rmSync(path.join(tmp, "state.json"));
    const fresh = await collector(["--backfill"]);
    expect(fresh.stdout).toMatch(/voice_memo duplicate 1; iphone_call duplicate 3; apple_note unchanged 2/);
    expect(sums()).toEqual(before);
  });

  it("files what it sent: Kevin's call to another_story, Daniel's (phalanx only) to inbox with a review row", async () => {
    const rows = (await pool.query(`select source, kind, source_ref, workspace_id, title, participants_raw, source_payload from interactions where source in ('voice_memo', 'iphone_call', 'apple_note') and source_ref is not null order by source, source_ref`)).rows;
    expect(rows.map((r) => [r.source, r.kind, r.source_ref, r.workspace_id])).toEqual([
      ["apple_note", "note", "apple_note:NOTE-0010-LONG", "inbox"],
      ["apple_note", "note", "apple_note:NOTE-0017-AUDI", "another_story"],
      ["iphone_call", "call", "notes:NOTE-0015-CALL:ATT-0200-CALL", "another_story"],
      ["iphone_call", "call", "notes:NOTE-0016-CALL:ATT-0201-CALL", "inbox"],
      ["iphone_call", "call", "notes:NOTE-0018-CALL:ATT-0203-CALL", "inbox"],
      ["voice_memo", "recording", "voice_memo:A1B2C3D4-0000-4000-8000-000000000001", "inbox"],
    ]);
    const kevin = rows.find((r) => r.source_ref.includes("NOTE-0015"))!;
    expect(kevin.participants_raw[0]).toMatchObject({ name: "Kevin McGuire", party_id: 2 });
    expect(kevin.source_payload.apple_transcript).toMatch(/drone pass/);
    const daniel = await pool.query(`select r.proposal from review_queue r join interactions i on i.id = r.interaction_id where i.source_ref like 'notes:NOTE-0016%'`);
    expect(daniel.rows[0].proposal.workspace_id).toBe("phalanx");
    const runs = (await pool.query(`select source, ok, counts_out from import_runs where source = 'apple_media' order by id`)).rows;
    expect(runs).toHaveLength(3);
    expect(runs[0].counts_out).toEqual({ created: { voice_memo: 1, iphone_call: 3, apple_note: 2 } });
    expect(runs.every((r) => r.ok)).toBe(true);
  });

  it("the meet step records the recording with its transcript and participants, marks the empty account, downloads and verifies", async () => {
    const r = await runWorker(ctx(), { trigger: "test", steps: ["meet"] });
    expect(r.ok, JSON.stringify(r.summary.errors)).toBe(true);
    const m = r.summary.meet!;
    expect(m.accounts.map((a) => [a.account, a.recordingsNew, a.transcripts, a.capability])).toEqual([
      ["ben@example.com", 1, 1, "recordings"],
      ["ops@example.com", 0, 0, "none_found"],
    ]);
    expect(m.filesVerified).toBe(1);
    const i = (await pool.query(`select * from interactions where source = 'meet'`)).rows[0];
    expect(i).toMatchObject({ kind: "meeting", source_ref: "meet:ben@example.com:drive-rec-0001", title: "Conroe shoot planning", workspace_id: "another_story", host_email: "ben@example.com" });
    expect(new Date(i.occurred_at).toISOString()).toBe("2026-10-22T14:29:52.000Z");
    expect(i.participants_raw).toEqual(expect.arrayContaining([{ identifier: "kevin.mcguire@example.com", kind: "email", name: "Kevin McGuire", party_id: 2 }]));
    const media = (await pool.query(`select kind, status, bytes, sha256 from media where interaction_id = $1 order by kind`, [i.id])).rows;
    expect(media.map((x) => [x.kind, x.status])).toEqual([["transcript_meet", "verified"], ["video", "verified"]]);
    expect(Number(media[1].bytes)).toBe(meetVideo.length);
    expect(media[1].sha256).toBe(crypto.createHash("sha256").update(meetVideo).digest("hex"));
    const acct = (await pool.query(`select account_email, capability, detail, last_error from message_accounts order by id`)).rows;
    expect(acct[1]).toMatchObject({ capability: "none_found", last_error: null });
    // Again: nothing new, no second download, no error loop on the empty account.
    const again = await runWorker(ctx(), { trigger: "test", steps: ["meet"] });
    expect(again.summary.meet!.accounts.map((a) => a.recordingsNew)).toEqual([0, 0]);
    expect(again.summary.meet!.filesVerified).toBe(0);
  });

  it("transcribes: the audio through (mocked) Groq, the meeting from Meet's own transcript; then embeds everything", async () => {
    const r = await runWorker(ctx(), { trigger: "test", steps: ["transcribe", "embed"] });
    expect(r.ok, JSON.stringify(r.summary)).toBe(true);
    // The seed's own queued recordings (no readable media) are candidates too; ours are the four done.
    expect(r.summary.transcribe).toMatchObject({ done: 5, viaGroq: 4, viaMeetTranscript: 1 });
    const rows = (await pool.query(
      `select i.id, i.source, i.kind, i.source_ref, i.workspace_id, i.title, i.pipeline_status, t.source as transcript_source, i.embedded_at is not null as embedded,
              (select count(*)::int from segments s where s.interaction_id = i.id) as segments, (select count(*)::int from chunks c where c.interaction_id = i.id) as chunks
         from interactions i left join transcripts t on t.interaction_id = i.id
        where i.source in ('voice_memo', 'iphone_call', 'apple_note', 'meet') and i.source_ref is not null order by i.id`,
    )).rows;
    expect(rows.every((x) => x.pipeline_status === "ready")).toBe(true);
    expect(rows.every((x) => x.embedded && x.chunks > 0)).toBe(true);
    expect(rows.filter((x) => x.source !== "apple_note").map((x) => x.transcript_source).sort()).toEqual(["groq", "groq", "groq", "groq", "meet_doc"]);
    const meet = rows.find((x) => x.source === "meet")!;
    const segs = (await pool.query(`select speaker, speaker_party_id from segments where interaction_id = $1 order by idx`, [meet.id])).rows;
    expect(segs.map((s) => s.speaker)).toEqual(["Ben Strout", "Kevin McGuire", "Ben Strout", "Kevin McGuire"]);
    if (VERIFY_OUT) {
      fs.mkdirSync(VERIFY_OUT, { recursive: true });
      fs.writeFileSync(path.join(VERIFY_OUT, ".e2e-rows.json"), JSON.stringify({ rows, transcribe: r.summary.transcribe, embed: { done: r.summary.embed?.done, chunks: r.summary.embed?.chunks } }, null, 2));
    }
  });
});
