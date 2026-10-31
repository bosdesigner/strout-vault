// Jarvis step 2: the extraction step (mock Claude) and applying approved proposals, on
// their own local database. Nothing reaches Anthropic, Neon, B2 or R2.
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
import { buildReport } from "../../server/worker/report.ts";
import { decideReview, ReviewError } from "../../server/services/review.ts";
import { ANTHROPIC_TEST_KEY, createMockServices } from "../mocks/zoomGroq.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-extract");
const TMP = path.join(os.tmpdir(), "strout-vault-extract-test");

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
    EXTRACT_MONTHLY_BUDGET_USD: "5",
    EXTRACT_MAX_PER_RUN: "3",
    // These tests cover the review path and the read bookkeeping: everything goes to Review, and the
    // classifier is not part of the run (tests/api/phase1.test.ts covers both).
    EXTRACT_FACT_MIN_CONFIDENCE: "1",
    EXTRACT_REQUIRE_CLASSIFIED: "0",
    ...overrides,
  });
}

function makeCtx(config: Config): WorkerContext {
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
  };
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0] as T;
}

async function queue(sql = "", params: unknown[] = []) {
  const { rows } = await pool.query(`select id, item_type, proposal, reason, interaction_id, status from review_queue where proposal->>'source' = 'extract' ${sql} order by id`, params);
  return rows as Array<{ id: number; item_type: string; proposal: Record<string, unknown>; reason: string; interaction_id: number; status: string }>;
}

async function enqueue(itemType: string, proposal: Record<string, unknown>, interactionId: number | null = null): Promise<number> {
  const r = await one<{ id: number }>(`insert into review_queue (item_type, proposal, reason, interaction_id) values ($1, $2::jsonb, 'test', $3) returning id`, [
    itemType,
    JSON.stringify({ ...proposal, source: "mcp", proposed_by: "test agent", token_id: null, proposed_at: new Date().toISOString() }),
    interactionId,
  ]);
  return r.id;
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  ({ url } = await resetDatabase(server, "strout_vault_extract", { seed: true, storageDir: STORAGE, quiet: true }));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  mock = createMockServices([]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
});

describe("extract step", () => {
  it("is off without a budget: counts what waits and sends nothing", async () => {
    const r = await runWorker(makeCtx(makeConfig({ EXTRACT_MONTHLY_BUDGET_USD: "0" })), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ configured: false, read: 0 });
    expect(r.summary.extract!.candidatesRecordings).toBeGreaterThan(0);
    expect(mock.extractRequests).toHaveLength(0);
    expect(formatRunSummary(r.summary)).toMatch(/^extract: off \(\d+ recording\(s\) waiting\)/m);
  });

  it("reads the newest filed recordings, queues what holds up, and records the spend under its own provider", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["extract"] });
    const s = r.summary.extract!;
    expect(s).toMatchObject({ configured: true, read: 3, failed: 0, waitingOnBudget: 0 });
    expect(s.spentUsd).toBeGreaterThan(0);

    const req = mock.extractRequests[0];
    expect(req).toMatchObject({ model: "claude-opus-5-5", effort: "medium", hasFormat: true, cachedSystem: true });
    expect(req.betas).toContain("server-side-fallback-2026-07-01");
    expect(req.context).toMatch(/^Recording #\d+/);
    expect(req.context).toContain("Known people and companies");
    expect(req.transcript).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);

    const read = await pool.query(`select id, workspace_id, extract_model from interactions where extracted_at is not null`);
    expect(read.rowCount).toBe(3);
    // Never phalanx by default, never unfiled.
    for (const row of read.rows) {
      expect(row.workspace_id).not.toBe("phalanx");
      expect(row.workspace_id).not.toBeNull();
      expect(row.extract_model).toBe("claude-opus-5-5");
    }

    const items = await queue();
    const facts = items.filter((i) => i.item_type === "new_fact");
    expect(facts.length).toBe(s.queued.facts);
    expect(s.queued.facts).toBe(3); // one per recording: the invented timestamp and the unsure one are dropped
    for (const f of facts) {
      expect(f.proposal).toMatchObject({ kind: "commitment", due_date: "2026-11-02", source: "extract", model: "claude-opus-5-5" });
      expect(f.proposal.about_party_id).toBeUndefined(); // 999999 was never offered
      expect(f.reason).toMatch(/^“.+” at \d{2}:\d{2}:\d{2}$/);
    }
    expect(items.some((i) => i.proposal.text === "Invented timestamp" || i.proposal.text === "Too unsure to queue")).toBe(false);
    expect(items.filter((i) => i.item_type === "link_project_interaction").every((i) => i.proposal.project_id !== 999999)).toBe(true);
    expect(items.filter((i) => i.item_type === "link_party_interaction").every((i) => i.proposal.speaker_label !== "Nobody In This Recording")).toBe(true);
    expect(items.filter((i) => i.item_type === "link_party_interaction").length).toBe(s.queued.speakers);
    expect(items.filter((i) => i.item_type === "link_project_interaction").length).toBe(s.queued.projects);

    const ledger = await pool.query(`select provider, model, usd::float8 as usd from spend_ledger where provider = 'anthropic-extract'`);
    expect(ledger.rowCount).toBe(3);
    expect(ledger.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(s.spentUsd, 6);
    expect((await one<{ n: number }>(`select count(*)::int as n from spend_ledger where provider = 'anthropic'`)).n).toBe(0);

    const report = await buildReport(pool, new Date());
    expect(report.extraction).toMatchObject({ read: 3, failed: 0 });
    // The auto-apply rules (docs/AUTO-APPLY.md) ran on each queued item: what the transcript itself
    // backs is applied and logged; the rest is still open for review.
    const auto = await pool.query(`select a.review_id, a.rule, a.actor from auto_applies a join review_queue rq on rq.id = a.review_id where rq.proposal->>'source' = 'extract'`);
    expect(auto.rowCount).toBe(1); // the mock speaker match whose name the transcript says
    expect(auto.rows.every((a) => a.actor === "extract" && a.rule.startsWith("additive:"))).toBe(true);
    for (const i of items) expect(i.status, `#${i.id}`).toBe(auto.rows.some((a) => Number(a.review_id) === i.id) ? "approved" : "open");
    expect(report.extraction!.openProposals).toBe(items.length - auto.rowCount!);
    expect(report.spend.extractUsd).toBeCloseTo(s.spentUsd, 6);
  });

  it("never reads a recording twice, and a re-read does not bring back what was decided", async () => {
    const next = await runWorker(makeCtx(makeConfig({ EXTRACT_MAX_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
    expect(next.summary.extract!.read).toBe(1); // the next unread one, not a re-read
    expect((await one<{ n: number }>(`select count(*)::int as n from interactions where extracted_at is not null`)).n).toBe(4);

    const facts = await queue(`and item_type = 'new_fact'`);
    const target = facts[0];
    await decideReview(pool, target.id, "reject");
    const count = (await queue()).length;
    await pool.query(`update interactions set extracted_at = null where id = $1`, [target.interaction_id]);
    const r = await runWorker(makeCtx(makeConfig({ EXTRACT_MAX_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract!.read).toBe(1);
    expect(r.summary.extract!.queued).toEqual({ facts: 0, speakers: 0, projects: 0 });
    expect((await queue()).length).toBe(count);
  });

  it("stops at the budget and marks the recording waiting", async () => {
    const calls = mock.extractRequests.length;
    const r = await runWorker(makeCtx(makeConfig({ EXTRACT_MONTHLY_BUDGET_USD: "0.0000001" })), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ read: 0, waitingOnBudget: 1, stoppedEarly: "extract budget" });
    expect(mock.extractRequests.length).toBe(calls);
    const waiting = await one(`select extract_error from interactions where extracted_at is null and extract_error is not null limit 1`);
    expect(String(waiting.extract_error)).toMatch(/^waiting: anthropic-extract monthly budget reached/);
  });

  it("reads phalanx only when EXTRACT_WORKSPACES lists it", async () => {
    await pool.query(`update interactions set extracted_at = now() where workspace_id <> 'phalanx'`);
    const off = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["extract"] });
    expect(off.summary.extract!.candidatesRecordings).toBe(0);
    const on = await runWorker(makeCtx(makeConfig({ EXTRACT_WORKSPACES: "*,phalanx", EXTRACT_MAX_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
    expect(on.summary.extract!.read).toBe(1);
    expect((await one(`select workspace_id from interactions where id = (select interaction_id from spend_ledger where provider = 'anthropic-extract' order by id desc limit 1)`)).workspace_id).toBe("phalanx");
  });

  it("treats a refusal as an empty answer and still marks the recording read", async () => {
    await pool.query(`update interactions set extracted_at = null where workspace_id = 'sepp'`);
    mock.setAnthropicMode("refusal");
    try {
      const r = await runWorker(makeCtx(makeConfig({ EXTRACT_WORKSPACES: "sepp", EXTRACT_MAX_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
      expect(r.summary.extract).toMatchObject({ read: 1, failed: 0, queued: { facts: 0, speakers: 0, projects: 0 } });
    } finally {
      mock.setAnthropicMode("ok");
    }
  });
});

describe("approving a proposal applies it", () => {
  it("new_fact from the extractor becomes a fact that points back at its review item", async () => {
    const [item] = await queue(`and item_type = 'new_fact' and status = 'open'`);
    const out = await decideReview(pool, item.id, "approve");
    expect(out.item.status).toBe("approved");
    expect(out.applied[0]).toMatch(/^facts #\d+$/);
    const fact = await one(`select * from facts where source_review_id = $1`, [item.id]);
    expect(fact).toMatchObject({ kind: "commitment", text: item.proposal.text, status: "open", interaction_id: item.interaction_id });
    expect(fact.workspace_id).toBe(item.proposal.workspace_id);
    expect(new Date(fact.due_date as string).toISOString().slice(0, 10)).toBe("2026-11-02");
  });

  it("link_party_interaction tags the person and assigns the speaker's lines", async () => {
    const [item] = await queue(`and item_type = 'link_party_interaction' and status = 'open'`);
    expect(item).toBeTruthy();
    const out = await decideReview(pool, item.id, "approve");
    expect(out.applied).toContain("interaction_participants");
    const p = await one(`select speaker_label from interaction_participants where interaction_id = $1 and party_id = $2`, [item.interaction_id, item.proposal.party_id]);
    expect(p.speaker_label).toBe(item.proposal.speaker_label);
    const lines = await one<{ n: number }>(`select count(*)::int as n from segments where interaction_id = $1 and speaker = $2 and speaker_party_id = $3`, [
      item.interaction_id,
      item.proposal.speaker_label,
      item.proposal.party_id,
    ]);
    expect(lines.n).toBeGreaterThan(0);
  });

  it("link_project_interaction links the recording to the project, once", async () => {
    const [item] = await queue(`and item_type = 'link_project_interaction' and status = 'open'`);
    expect(item).toBeTruthy();
    await decideReview(pool, item.id, "approve");
    const again = await enqueue("link_project_interaction", { project_id: item.proposal.project_id, interaction_id: item.interaction_id }, item.interaction_id);
    await decideReview(pool, again, "approve");
    expect((await one<{ n: number }>(`select count(*)::int as n from interaction_links where interaction_id = $1 and project_id = $2`, [item.interaction_id, item.proposal.project_id])).n).toBe(1);
  });

  it("new_party creates the party and its workspace role", async () => {
    const id = await enqueue("new_party", { kind: "person", name: "Dana Proposed", emails: ["dana@example.com"], role: { workspace_id: "strout_arch", role: "client", detail: "kitchen remodel" } });
    const out = await decideReview(pool, id, "approve");
    const party = await one(`select id, name, emails from parties where name = 'Dana Proposed'`);
    expect(party.emails).toEqual(["dana@example.com"]);
    expect(out.applied).toEqual([`parties #${party.id}`, "roles (strout_arch client)"]);
    expect(await one(`select role, detail from roles where party_id = $1`, [party.id])).toEqual({ role: "client", detail: "kitchen remodel" });
  });

  it("party_edit adds emails and phones to what is there instead of replacing them", async () => {
    const party = await one<{ id: string; emails: string[] }>(`select id, emails from parties where cardinality(emails) > 0 order by id limit 1`);
    const id = await enqueue("party_edit", { party_id: Number(party.id), changes: { emails: [party.emails[0].toUpperCase(), "second@example.com"], location: "Nashville, TN" } });
    await decideReview(pool, id, "approve");
    const after = await one<{ emails: string[]; location: string }>(`select emails, location from parties where id = $1`, [party.id]);
    expect(after.emails).toEqual([...party.emails, "second@example.com"]);
    expect(after.location).toBe("Nashville, TN");
  });

  it("new_relationship creates an edge, and approving it again adds evidence", async () => {
    const ids = (await pool.query(`select id from parties order by id limit 2`)).rows.map((r) => Number(r.id));
    const proposal = { from_party_id: ids[0], to_party_id: ids[1], kind: "referred_by_test" };
    await decideReview(pool, await enqueue("new_relationship", proposal), "approve");
    await decideReview(pool, await enqueue("new_relationship", proposal), "approve");
    const edges = await pool.query(`select evidence_count from relationships where from_party_id = $1 and to_party_id = $2 and kind = 'referred_by_test'`, ids);
    expect(edges.rows).toEqual([{ evidence_count: 2 }]);
  });

  it("an item that no longer applies fails with 400 and stays open", async () => {
    const id = await enqueue("link_party_interaction", { party_id: 987654, interaction_id: 1 }, 1);
    await expect(decideReview(pool, id, "approve")).rejects.toMatchObject({ status: 400, message: "unknown party 987654" });
    const bad = await enqueue("new_fact", { interaction_id: 1, kind: "rumour", text: "x" }, 1);
    const err = await decideReview(pool, bad, "approve").catch((e) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err.message).toMatch(/no longer matches the new_fact shape/);
    expect((await pool.query(`select status from review_queue where id = any($1::bigint[])`, [[id, bad]])).rows.map((r) => r.status)).toEqual(["open", "open"]);
    // Rejecting never applies anything, whatever the shape.
    expect((await decideReview(pool, bad, "reject")).applied).toEqual([]);
  });
});

describe("texts, email and unfiled recordings (step 5 B)", () => {
  const day = 86_400_000;
  let threadId: number;

  async function addInteraction(fields: { workspace_id: string | null; kind: string; title: string; occurred_at: Date }): Promise<number> {
    const r = await one<{ id: string }>(`insert into interactions (workspace_id, kind, title, occurred_at, source) values ($1, $2, $3, $4, 'test') returning id`, [
      fields.workspace_id,
      fields.kind,
      fields.title,
      fields.occurred_at,
    ]);
    return Number(r.id);
  }

  async function addSegments(id: number, lines: Array<[number, number, string, string]>): Promise<void> {
    for (const [idx, sec, speaker, text] of lines) {
      await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, $2, $3, $3, $4, $5)`, [id, idx, sec, speaker, text]);
    }
  }

  const config = (overrides: Record<string, string> = {}) => makeConfig({ EXTRACT_MAX_PER_RUN: "5", ...overrides });
  const lastRequest = () => mock.extractRequests[mock.extractRequests.length - 1];

  beforeAll(async () => {
    // Only what this block adds is waiting.
    await pool.query(`update interactions set extracted_at = now() where extracted_at is null`);
  });

  it("reads a recent email thread and remembers how far it read", async () => {
    threadId = await addInteraction({ workspace_id: "another_story", kind: "email_thread", title: "Re: floor plans", occurred_at: new Date(Date.now() - 2 * day) });
    await addSegments(threadId, [
      [0, 0, "Tanner Durfee", "Can you send over the floor plans?"],
      [1, 3600, "Ben", "Yes, I'll send the vetted set by Friday."],
      [2, 7200, "Tanner Durfee", "Perfect, thanks."],
    ]);
    const calls = mock.extractRequests.length;
    const r = await runWorker(makeCtx(config()), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ candidatesThreads: 1, read: 1, threads: 1, failed: 0 });
    expect(mock.extractRequests.length).toBe(calls + 1);
    expect(lastRequest().context).toMatch(/^Email thread #\d+: Re: floor plans/);
    expect(lastRequest().context).not.toContain("Earlier messages");
    expect(lastRequest().transcript).toMatch(/^New messages \(00:00:00 to 02:00:00\):/);
    expect((await one(`select extracted_through_idx from interactions where id = $1`, [threadId])).extracted_through_idx).toBe(2);
    const facts = await queue(`and interaction_id = $1 and item_type = 'new_fact'`, [threadId]);
    expect(facts).toHaveLength(1);
    expect(facts[0].proposal).toMatchObject({ workspace_id: "another_story", quote_start_sec: 0 });
    expect(formatRunSummary(r.summary)).toMatch(/^extract: 1\/1 item\(s\) read \(1 thread\(s\)\)/m);
    expect((await buildReport(pool, new Date())).extraction!.threads).toBe(1);
  });

  it("is not read again until it gains messages, then only the new ones are sent", async () => {
    const idle = await runWorker(makeCtx(config()), { trigger: "test", steps: ["extract"] });
    expect(idle.summary.extract!.candidatesThreads).toBe(0);

    await addSegments(threadId, [
      [3, 86_400, "Tanner Durfee", "Still waiting on those plans."],
      [4, 90_000, "Tanner Durfee", "Also, can we meet Tuesday?"],
    ]);
    const r = await runWorker(makeCtx(config()), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ read: 1, threads: 1 });
    const req = lastRequest();
    expect(req.transcript).toMatch(/^New messages \(24:00:00 to 25:00:00\):/);
    expect(req.transcript).toContain("Still waiting on those plans.");
    expect(req.transcript).not.toContain("Can you send over the floor plans?");
    expect(req.context).toContain("Earlier messages, already read (context only; extract nothing from these):");
    expect(req.context).toContain("Can you send over the floor plans?");
    expect(req.context).toMatch(/Already recorded from this conversation \(do not repeat\):\n- Mock: Can you send over the floor plans\?/);
    expect((await one(`select extracted_through_idx from interactions where id = $1`, [threadId])).extracted_through_idx).toBe(4);
    const facts = await queue(`and interaction_id = $1 and item_type = 'new_fact'`, [threadId]);
    expect(facts.map((f) => f.proposal.quote_start_sec)).toEqual([0, 86_400]);
  });

  it("skips threads that went quiet and all threads when EXTRACT_THREAD_DAYS is 0; reads personal threads (Phase 1 v2)", async () => {
    const old = await addInteraction({ workspace_id: "another_story", kind: "text_thread", title: "Texts with someone · old", occurred_at: new Date(Date.now() - 60 * day) });
    await addSegments(old, [[0, 0, "Someone", "See you then"]]);
    const personal = await addInteraction({ workspace_id: "personal", kind: "text_thread", title: "Texts with family", occurred_at: new Date(Date.now() - day) });
    await addSegments(personal, [[0, 0, "Mom", "Dinner Sunday?"]]);
    const fresh = await addInteraction({ workspace_id: "strout_arch", kind: "text_thread", title: "Texts with a client", occurred_at: new Date(Date.now() - day) });
    await addSegments(fresh, [[0, 0, "Dana Client", "Can you call me about the kitchen?"]]);

    const off = await runWorker(makeCtx(config({ EXTRACT_THREAD_DAYS: "0" })), { trigger: "test", steps: ["extract"] });
    expect(off.summary.extract!.candidatesThreads).toBe(0);

    const r = await runWorker(makeCtx(config()), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ candidatesThreads: 2, threads: 2 });
    const read = await pool.query(`select id from interactions where id = any($1::bigint[]) and extracted_at is not null order by id`, [[old, personal, fresh]]);
    expect(read.rows.map((x) => Number(x.id))).toEqual([personal, fresh]);
  });

  it("never reads unfiled or inbox items: they wait for the content classifier", async () => {
    const unfiled = await addInteraction({ workspace_id: null, kind: "meeting", title: "Jane Prospect: AnotherStory Assessment", occurred_at: new Date(Date.now() - day) });
    await addSegments(unfiled, [[0, 5, "Speaker 1", "Thanks for jumping on, Jane."]]);
    const inbox = await addInteraction({ workspace_id: "inbox", kind: "note", title: "Call Dana about the deck", occurred_at: new Date(Date.now() - day) });
    await addSegments(inbox, [[0, 0, "", "Call Dana about the deck Friday"]]);
    const r = await runWorker(makeCtx(config()), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ read: 0 });
    const read = await pool.query(`select id from interactions where id = any($1::bigint[]) and extracted_at is not null`, [[unfiled, inbox]]);
    expect(read.rowCount).toBe(0);
    await pool.query(`update interactions set extracted_at = now() where id = any($1::bigint[])`, [[unfiled, inbox]]);
  });

  it("reads the last 30 days first, then the older backlog, newest first", async () => {
    const old = await one<{ id: string }>(`select id from interactions where workspace_id = 'strout_arch' and kind <> all('{text_thread,email_thread}') order by occurred_at asc limit 1`);
    await pool.query(`update interactions set extracted_at = null, occurred_at = $2 where id = $1`, [old.id, new Date(Date.now() - 300 * day)]);
    const fresh = await addInteraction({ workspace_id: "another_story", kind: "note", title: "Robin follow-ups", occurred_at: new Date(Date.now() - day) });
    await addSegments(fresh, [[0, 0, "", "Send Robin the survey quote by Friday."]]);

    const r = await runWorker(makeCtx(config({ EXTRACT_MAX_PER_RUN: "1", EXTRACT_THREADS_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
    expect(r.summary.extract).toMatchObject({ read: 1 });
    expect((await one(`select extracted_at from interactions where id = $1`, [fresh])).extracted_at).not.toBeNull(); // a note: every kind is read now
    expect((await one(`select extracted_at from interactions where id = $1`, [old.id])).extracted_at).toBeNull();

    // Next run, the older backlog gets its turn.
    const next = await runWorker(makeCtx(config({ EXTRACT_MAX_PER_RUN: "1", EXTRACT_THREADS_PER_RUN: "1" })), { trigger: "test", steps: ["extract"] });
    expect(next.summary.extract).toMatchObject({ read: 1 });
    expect((await one(`select extracted_at from interactions where id = $1`, [old.id])).extracted_at).not.toBeNull();
  });
});
