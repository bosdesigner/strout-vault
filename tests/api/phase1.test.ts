// Phase 1 (docs/phase1-verification.md) on its own local database: the participant resolver and
// filing (Zoom titles, leads, typo suggestions, iPhone calls, guardrails, dry run, Zoom's missing
// scope), and extraction writing open facts directly (quote, message index, spoken due dates,
// repeats across an email and two calls folded into one fact, notes, the MCP tool, closing a fact).
// Claude, Zoom and Google are mocked here; nothing reaches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { loadConfig, type Config } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { runWorker, formatRunSummary } from "../../server/worker/run.ts";
import { processResolve, pickCalendarEvent } from "../../server/worker/resolve.ts";
import { PartyIndex, resolveInteraction, type ResolveDeps } from "../../server/participants/resolve.ts";
import { ownerIdentity } from "../../server/messages/identity.ts";
import { emptyRules } from "../../server/messages/rules.ts";
import { loadFilingRules } from "../../server/workspaces/filing.ts";
import { listOpenCommitments } from "../../server/mcp/tools/commitments.ts";
import { resolveScope } from "../../server/mcp/scope.ts";
import type { ToolContext } from "../../server/mcp/tools/types.ts";
import { buildTestApp, login } from "../helpers.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-phase1");
const TMP = path.join(os.tmpdir(), "strout-vault-phase1-test");
const NOW = new Date("2026-10-29T12:00:00Z");
const OWNER_EMAIL = "ben@example.com"; // seed party 1, Ben Strout

let url: string;
let readerUrl: string;
let pool: pg.Pool;
let storage: LocalStorageDriver;
const ids: Record<string, number> = {};

// ---- mocks ------------------------------------------------------------------------------

/** Scripted Claude for extraction: per interaction id, the facts it "finds", given the context it was sent. */
type FactOut = Record<string, unknown>;
const scripts = new Map<number, (context: string, transcript: string) => FactOut[]>();
const claudeRequests: Array<{ id: number; context: string; transcript: string }> = [];
let zoomParticipantsStatus = 403;
const zoomCalls = { token: 0, participants: 0 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchImpl: typeof fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (u.host === "anthropic.test" && u.pathname === "/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const blocks = body.messages[0].content as Array<{ text: string }>;
    const context = blocks[0].text;
    const transcript = blocks[1].text;
    const id = Number(context.match(/#(\d+):/)?.[1]);
    claudeRequests.push({ id, context, transcript });
    const facts = (scripts.get(id)?.(context, transcript) ?? []).map((f) => ({
      kind: "commitment",
      owner_party_id: null,
      about_party_id: null,
      project_id: null,
      amount: null,
      due_date: null,
      due_text: null,
      quote_start_sec: 0,
      quote: "",
      confidence: 0.9,
      same_as_fact_id: null,
      ...f,
    }));
    return json({
      id: `msg_${claudeRequests.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify({ facts, speakers: [], projects: [] }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }
  if (u.host === "zoom.test" && u.pathname === "/oauth/token") {
    zoomCalls.token++;
    return json({ access_token: "zoom-test-token", expires_in: 3600 });
  }
  if (u.host === "zoom.test" && u.pathname.startsWith("/v2/past_meetings/")) {
    zoomCalls.participants++;
    if (zoomParticipantsStatus !== 200) return json({ code: 4711, message: "Invalid access token, does not contain scopes:[meeting:read:admin]." }, zoomParticipantsStatus);
    return json({ participants: [{ name: "Dana Rivers", user_email: "dana@rivers.example" }], next_page_token: "" });
  }
  return json({ error: `no mock for ${u.host}${u.pathname}` }, 404);
};

function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url,
    SESSION_SECRET: "test-secret-test-secret-test-secret",
    ADMIN_EMAIL: "owner@test.local",
    ADMIN_PASSWORD_HASH: "$2b$12$n.14Mj6k0QzvENVWdt4cSuCT51Njj30l5Hsv60FoeGYekXVMpWypO",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: STORAGE,
    OWNER_EMAILS: OWNER_EMAIL,
    ANTHROPIC_API_KEY: "anthropic-test-key",
    ANTHROPIC_API_URL: "https://anthropic.test",
    EXTRACT_MONTHLY_BUDGET_USD: "5",
    ...overrides,
  });
}

function makeCtx(config: Config): WorkerContext {
  return {
    config,
    pool,
    storage,
    fetchImpl,
    sleep: async () => {},
    now: () => NOW,
    log: () => {},
    tmpDir: TMP,
    tools: { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN },
    deadline: NOW.getTime() + 10 * 60_000,
    bytesBudget: 1e12,
  };
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0] as T;
}

async function party(name: string, opts: { emails?: string[]; role?: [string, string] } = {}): Promise<number> {
  const { id } = await one<{ id: number }>(`insert into parties (kind, name, emails) values ('person', $1, $2::text[]) returning id`, [name, opts.emails ?? []]);
  if (opts.role) await pool.query(`insert into roles (workspace_id, party_id, role) values ($1, $2, $3)`, [opts.role[0], id, opts.role[1]]);
  return Number(id);
}

async function interaction(o: { title: string; source: string; kind: string; workspace?: string | null; at: string; ref?: string; raw?: unknown[] }): Promise<number> {
  const { id } = await one<{ id: number }>(
    `insert into interactions (kind, source, source_ref, title, occurred_at, workspace_id, participants_raw, pipeline_status, duration_sec)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ready', 1800) returning id`,
    [o.kind, o.source, o.ref ?? `${o.source}-${Math.random().toString(36).slice(2)}`, o.title, o.at, o.workspace ?? null, o.raw ? JSON.stringify(o.raw) : null],
  );
  return Number(id);
}

async function segments(interactionId: number, lines: Array<[number, string | null, string]>, transcriptSource: string | null = "zoom_vtt"): Promise<void> {
  for (const [i, [sec, speaker, text]] of lines.entries()) {
    await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, $2, $3, $3, $4, $5)`, [interactionId, i, sec, speaker, text]);
  }
  if (transcriptSource) await pool.query(`insert into transcripts (interaction_id, source, segment_count, word_count) values ($1, $2, $3, 50)`, [interactionId, transcriptSource, lines.length]);
}

const participantsOf = async (id: number) =>
  (await pool.query(`select p.name, ip.resolved_by from interaction_participants ip join parties p on p.id = ip.party_id where ip.interaction_id = $1 order by p.name`, [id])).rows as Array<{ name: string; resolved_by: string | null }>;

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const r = await resetDatabase(server, "strout_vault_phase1", { seed: true, storageDir: STORAGE, quiet: true });
  url = r.url;
  readerUrl = r.readerUrl;
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  // The seed's own recordings are someone else's test: out of the way of these steps.
  await pool.query(`update interactions set participants_resolved_at = now(), extracted_at = now()`);

  ids.tanner = await party("Tanner Durfee", { role: ["another_story", "contractor"] });
  ids.benjamin = await party("Benjamin Schiavi", { role: ["another_story", "prospect"] });
  ids.ryan = await party("ryan@bvmhomes.example", { emails: ["ryan@bvmhomes.example"], role: ["another_story", "prospect"] });
  await pool.query(`insert into lead_records (party_id, origin, origin_id, name, email, lead_type, workspace_id) values ($1, 'airtable_contractor_intake', 'rec1', 'Ryan Meagher', 'ryan@bvmhomes.example', 'contractor', 'another_story')`, [ids.ryan]);
  ids.barry = await party("Barry Harwell", { role: ["another_story", "client"] });
  ids.dana = await party("Dana Rivers", { emails: ["dana@rivers.example"], role: ["phalanx", "investor"] });

  ids.z1 = await interaction({ title: "Tanner Durfee: AnotherStory Assessment", source: "zoom", kind: "meeting", at: "2026-10-27T19:31:36Z" });
  ids.z2 = await interaction({ title: "Allan Lajeunesse : AnotherStory Assessment", source: "zoom", kind: "meeting", at: "2026-10-28T14:00:31Z" });
  ids.z3 = await interaction({ title: "Bejamin Schiavi: AnotherStory Assessment", source: "zoom", kind: "meeting", at: "2026-10-27T18:58:51Z" });
  ids.z4 = await interaction({ title: "Ryan Meagher: AnotherStory Assessment", source: "zoom", kind: "meeting", at: "2026-10-28T19:30:28Z" });
  ids.z5 = await interaction({ title: "Ben Strout's Zoom Meeting", source: "zoom", kind: "meeting", at: "2026-10-20T15:00:00Z" });
  ids.z6 = await interaction({ title: "Meeting with Dana Rivers", source: "zoom", kind: "meeting", at: "2026-10-21T15:00:00Z" });
  ids.z7 = await interaction({ title: "Feasibility Study Delivery - Oak St", source: "zoom", kind: "meeting", at: "2026-10-22T15:00:00Z" });
  await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('interaction_workspace', $1::jsonb, 'test', $2, 'rejected')`, [
    JSON.stringify({ interaction_id: ids.z7, workspace_id: "another_story" }),
    ids.z7,
  ]);
  ids.c1 = await interaction({ title: "Call with Barry Harwell · 2026-10-27", source: "iphone_call", kind: "call", workspace: "inbox", at: "2026-10-27T22:23:23Z", raw: [{ kind: "name", name: "Barry Harwell", party_id: null, identifier: null }] });
  ids.c2 = await interaction({ title: "Call with Devon · 2026-10-28", source: "iphone_call", kind: "call", workspace: "inbox", at: "2026-10-28T19:14:54Z", raw: [{ kind: "name", name: "Devon", party_id: null, identifier: null }] });
}, 180_000);

afterAll(async () => {
  await pool?.end();
});

// ---- participants and filing ---------------------------------------------------------------

describe("resolve step: participants and filing", () => {
  it("dry run shows what it would do and keeps nothing", async () => {
    const before = await one<{ n: number }>(`select count(*)::int as n from interaction_participants`);
    const s = await processResolve(makeCtx(makeConfig()), { dryRun: true, keepResults: true, inspect: async (db) => (await db.query(`select count(*)::int as n from interactions where workspace_id is null and source = 'zoom'`)).rows[0] });
    expect(s.dryRun).toBe(true);
    expect(s.checked).toBe(9);
    expect(s.results!.find((r) => r.interactionId === ids.z1)).toMatchObject({ workspaceAfter: "another_story", filedBy: "rule:1" });
    expect((await one<{ n: number }>(`select count(*)::int as n from interaction_participants`)).n).toBe(before.n);
    expect((await one(`select workspace_id, participants_resolved_at from interactions where id = $1`, [ids.z1])).workspace_id).toBeNull();
    expect((await one<{ n: number }>(`select count(*)::int as n from parties where name = 'Allan Lajeunesse'`)).n).toBe(0);
    expect(s.inspected?.n).toBeLessThan(7); // inside the transaction the assessments were filed
  });

  it("files by title rule, links known people, leads and new people, and suggests typos instead of merging", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["resolve"] });
    const s = r.summary.resolve!;
    expect(s).toMatchObject({ checked: 9, dryRun: false, zoomApi: "off", calendar: "off" });
    expect(formatRunSummary(r.summary)).toMatch(/^resolve: 9 recording\(s\)\/call\(s\) checked/m);

    // Title rule + known person by name.
    expect(await one(`select workspace_id, filed_by from interactions where id = $1`, [ids.z1])).toMatchObject({ workspace_id: "another_story", filed_by: "rule:1" });
    expect(await participantsOf(ids.z1)).toEqual([{ name: "Tanner Durfee", resolved_by: "title" }]);
    // Stray space before the colon, nobody known: one new party with a real name.
    expect(await participantsOf(ids.z2)).toEqual([{ name: "Allan Lajeunesse", resolved_by: "title" }]);
    expect(await one(`select external_refs->>'created_by' as by from parties where name = 'Allan Lajeunesse'`)).toMatchObject({ by: "participant-resolver" });
    // A typo of a known person: filed, but nobody linked or created; a suggestion on Review instead.
    expect(await participantsOf(ids.z3)).toEqual([]);
    expect((await one<{ n: number }>(`select count(*)::int as n from parties where name ilike 'bejamin%'`)).n).toBe(0);
    const sugg = await one<{ proposal: Record<string, unknown>; reason: string; status: string }>(`select proposal, reason, status from review_queue where interaction_id = $1 and item_type = 'link_party_interaction'`, [ids.z3]);
    expect(sugg).toMatchObject({ status: "open", proposal: { party_id: ids.benjamin, interaction_id: ids.z3 } });
    expect(sugg.reason).toMatch(/Bejamin Schiavi.*Benjamin Schiavi/);
    // The lead's name lives on its lead record (the party is named after the email): linked to the lead.
    expect(await participantsOf(ids.z4)).toEqual([{ name: "ryan@bvmhomes.example", resolved_by: "title" }]);
    expect(s.leadsLinked).toBeGreaterThanOrEqual(1);
    // Nothing in the title: stays unassigned.
    expect(await one(`select workspace_id from interactions where id = $1`, [ids.z5])).toMatchObject({ workspace_id: null });
    // Known person whose only workspace is phalanx: linked, never filed under phalanx.
    expect(await participantsOf(ids.z6)).toEqual([{ name: "Dana Rivers", resolved_by: "title" }]);
    expect(await one(`select workspace_id from interactions where id = $1`, [ids.z6])).toMatchObject({ workspace_id: null });
    // Ben rejected this filing on Review once: the rule does not make it again.
    expect(await one(`select workspace_id from interactions where id = $1`, [ids.z7])).toMatchObject({ workspace_id: null });
    // iPhone call: contact name matched, moved out of inbox by the person's workspace.
    expect(await participantsOf(ids.c1)).toEqual([{ name: "Barry Harwell", resolved_by: "contact" }]);
    expect(await one(`select workspace_id, filed_by from interactions where id = $1`, [ids.c1])).toMatchObject({ workspace_id: "another_story", filed_by: "participants" });
    // A first name alone is never made into a person.
    expect(await participantsOf(ids.c2)).toEqual([]);
    expect(await one(`select workspace_id from interactions where id = $1`, [ids.c2])).toMatchObject({ workspace_id: "inbox" });

    // Resolved once: the next run has nothing to do.
    const again = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["resolve"] });
    expect(again.summary.resolve!.checked).toBe(0);
  });

  it("uses Zoom's participant list when the app has the scope, and backs off for a day when it does not", async () => {
    const zoom = { ZOOM_ACCOUNT_ID: "acct", ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "secret", ZOOM_API_BASE: "https://zoom.test/v2", ZOOM_OAUTH_BASE: "https://zoom.test" };
    zoomParticipantsStatus = 403;
    const refused = await processResolve(makeCtx(makeConfig(zoom)), { again: true, ids: [ids.z5] });
    expect(refused.zoomApi).toMatch(/^unavailable \(HTTP 403/);
    expect(await one(`select value->>'available' as available from worker_state where key = 'zoom_participants'`)).toMatchObject({ available: "false" });
    const calls = zoomCalls.participants;
    const later = await processResolve(makeCtx(makeConfig(zoom)), { again: true, ids: [ids.z5] });
    expect(zoomCalls.participants).toBe(calls); // not asked again within the day
    expect(later.zoomApi).toMatch(/^unavailable/);

    // Scope granted (state cleared): the participant list links by email, Ben excluded.
    await pool.query(`delete from worker_state where key = 'zoom_participants'`);
    zoomParticipantsStatus = 200;
    const ok = await processResolve(makeCtx(makeConfig(zoom)), { again: true, ids: [ids.z5] });
    expect(ok.zoomApi).toBe("ok");
    expect(await participantsOf(ids.z5)).toEqual([{ name: "Dana Rivers", resolved_by: "zoom_api" }]);
  });

  it("matches calendar guests by email, creates a person for an unknown email, and never links Ben", async () => {
    const zid = await interaction({ title: "Kitchen walkthrough", source: "zoom", kind: "meeting", at: "2026-10-25T15:00:00Z" });
    const deps: ResolveDeps = {
      owner: ownerIdentity({ OWNER_EMAILS: OWNER_EMAIL }),
      ownerNames: ["Ben", "Ben Strout"],
      rules: emptyRules(),
      filingRules: loadFilingRules(path.join(REPO_ROOT, "config")),
      calendarAttendees: async () => [
        { email: "dana@rivers.example", name: "Dana R." },
        { email: "new.person@example.org", name: "Pat Newcomer" },
        { email: OWNER_EMAIL, name: "Ben Strout" },
      ],
    };
    const db = await pool.connect();
    try {
      const row = (await db.query(`select id, title, source, source_ref, kind, occurred_at, duration_sec, workspace_id, host_email, participants_raw from interactions where id = $1`, [zid])).rows[0];
      const r = await resolveInteraction(db, deps, await PartyIndex.load(db), row);
      expect(r.linked.map((l) => [l.name, l.via, l.how])).toEqual([
        ["Dana Rivers", "calendar", "email"],
        ["Pat Newcomer", "calendar", "created"],
      ]);
    } finally {
      db.release();
    }
  });

  it("picks the calendar event that looks like the call", () => {
    const start = new Date("2026-10-27T19:30:00Z");
    const ev = (id: string, summary: string, at: string, extra: Record<string, unknown> = {}) => ({ id, summary, start: { dateTime: at }, attendees: [{ email: `${id}@x.example` }], ...extra });
    const events = [ev("lunch", "Lunch", "2026-10-27T19:15:00Z"), ev("tanner", "Tanner Durfee and Ben Strout", "2026-10-27T19:30:00Z", { location: "https://us06web.zoom.us/j/123" })];
    expect(pickCalendarEvent(events, start, "Tanner Durfee: AnotherStory Assessment")?.id).toBe("tanner");
    expect(pickCalendarEvent([ev("only", "Something", "2026-10-27T19:30:00Z")], start, "Ben Strout's Zoom Meeting")?.id).toBe("only");
    expect(pickCalendarEvent([], start, "x")).toBeNull();
  });
});

// ---- extraction writes facts -----------------------------------------------------------------

describe("extraction writes open facts", () => {
  beforeAll(async () => {
    await pool.query(`update interactions set extracted_at = now()`);
    // An email on Monday; Tanner promises the framing plan on Tuesday morning (Central).
    ids.t1 = await interaction({ title: "Framing plan", source: "gmail", kind: "email_thread", workspace: "another_story", at: "2026-10-26T15:00:00Z" });
    await segments(
      ids.t1,
      [
        [0, "Ben", "Can you get me the framing plan?"],
        [3600, "Tanner Durfee", "Looking at it now."],
        [90000, "Tanner Durfee", "I'll send the framing plan Friday."],
      ],
      null,
    );
    await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2)`, [ids.t1, ids.tanner]);
    // Two later calls repeat it: one the model recognises, one only the wording gives away.
    ids.r1 = await interaction({ title: "Tanner check-in", source: "zoom", kind: "meeting", workspace: "another_story", at: "2026-10-28T15:00:00Z" });
    await segments(ids.r1, [
      [0, null, "Hey Tanner."],
      [120, null, "Yeah, the framing plan, you'll have it Friday."],
      [200, null, "We should get together sometime."],
    ]);
    ids.r2 = await interaction({ title: "Tanner site visit", source: "zoom", kind: "meeting", workspace: "another_story", at: "2026-10-28T18:00:00Z" });
    await segments(ids.r2, [[60, null, "Framing plan Friday for sure."]]);
    for (const r of [ids.r1, ids.r2]) await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2)`, [r, ids.tanner]);
    // A plain Apple Note in inbox: paragraphs, all at 0 s.
    ids.n1 = await interaction({ title: "To do", source: "apple_note", kind: "note", workspace: "inbox", at: "2026-10-27T03:00:00Z" });
    await segments(
      ids.n1,
      [
        [0, null, "Groceries"],
        [0, null, "Call the county about the permit by Nov 3"],
      ],
      null,
    );

    scripts.set(ids.t1, () => [{ text: "Tanner Durfee will send Ben the framing plan", owner_party_id: ids.tanner, due_text: "Friday", quote_start_sec: 90000, quote: "I'll send the framing plan Friday." }]);
    scripts.set(ids.r1, (context) => {
      const known = context.match(/^- (\d+) · commitment · Tanner Durfee will send Ben the framing plan/m);
      return [
        { text: "Tanner will get Ben the framing plan by Friday", owner_party_id: ids.tanner, due_text: "Friday", quote_start_sec: 120, quote: "the framing plan, you'll have it Friday", same_as_fact_id: known ? Number(known[1]) : null },
        { kind: "followup", text: "Ben and Tanner should get together sometime", quote_start_sec: 200, quote: "We should get together sometime.", confidence: 0.65 },
      ];
    });
    scripts.set(ids.r2, () => [{ text: "Tanner Durfee will send Ben the framing plan Friday", owner_party_id: ids.tanner, due_text: "Friday", quote_start_sec: 60, quote: "Framing plan Friday for sure." }]);
    scripts.set(ids.n1, (_c, transcript) => {
      expect(transcript).toMatch(/paragraph number/);
      return [{ kind: "task", text: "Ben will call the county about the permit", owner_party_id: 1, due_text: "by Nov 3", quote_start_sec: 1, quote: "Call the county about the permit by Nov 3" }];
    });
  });

  it("writes a fact with its quote, message index and spoken due date, and folds repeats into it", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["extract"] });
    const x = r.summary.extract!;
    expect(x).toMatchObject({ configured: true, failed: 0 });
    expect(x.read).toBe(4);
    expect(x.written).toEqual({ facts: 2, merged: 2 });
    expect(formatRunSummary(r.summary)).toMatch(/2 fact\(s\) written \(2 merged into ones on record\)/);

    const facts = (await pool.query(`select * from facts where origin = 'extract' order by id`)).rows;
    expect(facts).toHaveLength(2);
    const plan = facts.find((f) => f.interaction_id === ids.t1)!;
    expect(plan).toMatchObject({
      kind: "commitment",
      text: "Tanner Durfee will send Ben the framing plan",
      status: "open",
      origin: "extract",
      owner_party_id: ids.tanner,
      workspace_id: "another_story",
      quote: "I'll send the framing plan Friday.",
      message_index: 2,
      due_text: "Friday",
      quote_start_sec: 90000,
    });
    // Said Tuesday 2026-10-27 at 10 AM Central: "Friday" is 2026-10-30.
    expect(String(plan.due_date).slice(0, 10)).toBe("2026-10-30");
    const sources = (await pool.query(`select interaction_id, quote, quote_start_sec, message_index from fact_sources where fact_id = $1 order by interaction_id`, [plan.id])).rows;
    expect(sources.map((s) => Number(s.interaction_id)).sort()).toEqual([ids.t1, ids.r1, ids.r2].sort());

    // The model was shown the open fact for Tanner when it read the call.
    expect(claudeRequests.find((q) => q.id === ids.r1)!.context).toContain("Open items already on record for these people");

    // The Apple Note's task: Ben owns it, paragraph 1, resolved due date, inbox.
    const task = facts.find((f) => f.interaction_id === ids.n1)!;
    expect(task).toMatchObject({ kind: "task", owner_party_id: 1, message_index: 1, quote_start_sec: 0, workspace_id: "inbox" });
    expect(String(task.due_date).slice(0, 10)).toBe("2026-11-03");

    // "We should get together sometime" is not a commitment: under the bar, so it waits on Review instead.
    expect((await pool.query(`select 1 from facts where text ilike '%sometime%'`)).rowCount).toBe(0);
    expect((await pool.query(`select 1 from review_queue where item_type = 'new_fact' and interaction_id = $1 and proposal->>'text' ilike '%sometime%'`, [ids.r1])).rowCount).toBe(1);

    expect((await pool.query(`select facts_status from interactions where id = any($1::bigint[])`, [[ids.t1, ids.r1, ids.r2, ids.n1]])).rows.every((r) => r.facts_status === "done")).toBe(true);
    const report = r.summary;
    expect(report.extract!.spentUsd).toBeGreaterThan(0);
  });

  it("list_open_commitments returns the fact with its quote and every other moment, within scope", async () => {
    const reader = new pg.Pool({ connectionString: readerUrl, max: 2 });
    try {
      const ctx = (scope: string[]): ToolContext =>
        ({ reader, proposer: reader, publicUrl: "https://vault.test", embeddings: null, now: () => NOW, principal: { kind: "token", tokenId: 1, name: "test" } }) as unknown as ToolContext;
      const star = { ...ctx(["*"]), scope: await resolveScope(pool, ["*"]) };
      const out = await listOpenCommitments.run({ limit: 20 }, star);
      const items = out.result.items as Array<Record<string, unknown>>;
      const plan = items.find((i) => String(i.text).includes("framing plan"))!;
      expect(plan).toMatchObject({ kind: "commitment", quote: "I'll send the framing plan Friday.", due_date: "2026-10-30", due_text: "Friday", owner: { name: "Tanner Durfee" } });
      expect((plan.source as Record<string, unknown>).message_index).toBe(2);
      expect((plan.also_said_in as unknown[]).length).toBe(2);
      // The note's task is in inbox: not visible to a "*" token, visible once inbox is granted.
      expect(items.some((i) => String(i.text).includes("county"))).toBe(false);
      const withInbox = await listOpenCommitments.run({ workspace: "inbox", limit: 20 }, { ...ctx(["*", "inbox"]), scope: await resolveScope(pool, ["*", "inbox"]) });
      expect((withInbox.result.items as Array<Record<string, unknown>>).some((i) => String(i.text).includes("county"))).toBe(true);
    } finally {
      await reader.end();
    }
  });

  it("closing a fact takes it off the open list, and Undo brings it back", async () => {
    const t = await buildTestApp({ DATABASE_URL: url, LOCAL_STORAGE_DIR: STORAGE });
    try {
      const s = await login(t.app);
      const fact = await one<{ id: number }>(`select id from facts where interaction_id = $1`, [ids.t1]);
      const page = await s.agent.get(`/api/interactions/${ids.r1}`);
      expect(page.status).toBe(200);
      // The call that repeated the promise shows it, at its own moment and in its own words.
      expect(page.body.facts).toEqual([expect.objectContaining({ id: Number(fact.id), quoteStartSec: 120, quote: "the framing plan, you'll have it Friday", status: "open" })]);

      expect((await s.agent.patch(`/api/facts/${fact.id}`).send({ status: "done" })).status).toBe(403); // CSRF
      const done = await s.agent.patch(`/api/facts/${fact.id}`).set("x-csrf-token", s.csrf).send({ status: "done" });
      expect(done.status).toBe(200);
      expect(done.body.fact).toMatchObject({ id: Number(fact.id), status: "done" });
      expect(done.body.fact.closedAt).toBeTruthy();
      expect((await pool.query(`select 1 from facts where id = $1 and status = 'open'`, [fact.id])).rowCount).toBe(0);

      const undo = await s.agent.patch(`/api/facts/${fact.id}`).set("x-csrf-token", s.csrf).send({ status: "open" });
      expect(undo.body.fact).toMatchObject({ status: "open", closedAt: null });
      expect((await s.agent.patch(`/api/facts/999999`).set("x-csrf-token", s.csrf).send({ status: "done" })).status).toBe(404);
      expect((await s.agent.patch(`/api/facts/${fact.id}`).set("x-csrf-token", s.csrf).send({ status: "finished" })).status).toBe(400);
    } finally {
      await t.close();
    }
  });
});
