// Jarvis step 5 C: the follow-through step (mock Claude) and what approving its proposals does, on
// its own local database. Nothing reaches Anthropic, Neon, Gmail or anyone's phone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { loadConfig, type Config } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { formatRunSummary, runWorker } from "../../server/worker/run.ts";
import { decideReview, ReviewError, updateDraft } from "../../server/services/review.ts";
import { ANTHROPIC_TEST_KEY, createMockServices } from "../mocks/zoomGroq.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-followthrough");
const TMP = path.join(os.tmpdir(), "strout-vault-followthrough-test");
const DAY = 86_400_000;

let url: string;
let pool: pg.Pool;
let storage: LocalStorageDriver;
let mock: ReturnType<typeof createMockServices>;
const ids: Record<string, number> = {};

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
    OWNER_EMAILS: "ben@example.com",
    OWNER_NAME: "Ben",
    FOLLOWTHROUGH_MONTHLY_BUDGET_USD: "5",
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

async function party(name: string, emails: string[] = [], phones: string[] = []): Promise<number> {
  return Number((await one<{ id: string }>(`insert into parties (kind, name, emails, phones) values ('person', $1, $2, $3) returning id`, [name, emails, phones])).id);
}

/** A text or email thread as the message ingest stores it: payload messages, segments, participants. */
async function thread(opts: { kind: "email_thread" | "text_thread"; workspace: string; title: string; messages: Array<{ fromMe: boolean; partyId?: number; speaker: string; text: string; at: Date; from?: string }> }): Promise<number> {
  const t0 = opts.messages[0].at.getTime();
  const payload = {
    messages: opts.messages.map((m, idx) => ({ idx, id: `msg-${idx}`, sent_at: m.at.toISOString(), from_me: m.fromMe, from: m.from ?? (m.fromMe ? "ben@example.com" : null) })),
  };
  const id = Number(
    (
      await one<{ id: string }>(
        `insert into interactions (workspace_id, kind, title, occurred_at, source, source_ref, source_payload, updated_at) values ($1, $2, $3, $4, 'gmail', $5, $6::jsonb, now()) returning id`,
        [opts.workspace, opts.kind, opts.title, opts.messages[0].at, `thread-${Math.random()}`, JSON.stringify(payload)],
      )
    ).id,
  );
  for (const [idx, m] of opts.messages.entries()) {
    const sec = (m.at.getTime() - t0) / 1000;
    await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, speaker_party_id, text) values ($1, $2, $3, $3, $4, $5, $6)`, [id, idx, sec, m.speaker, m.partyId ?? null, m.text]);
    if (m.partyId) await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2) on conflict do nothing`, [id, m.partyId]);
  }
  return id;
}

async function fact(f: { interactionId: number; text: string; owner?: number | null; about?: number | null; due?: string | null; kind?: string; sec?: number }): Promise<number> {
  return Number(
    (
      await one<{ id: string }>(
        `insert into facts (interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, due_date, status, quote_start_sec) values ($1, 'another_story', $2, $3, $4, $5, $6, 'open', $7) returning id`,
        [f.interactionId, f.kind ?? "commitment", f.text, f.owner ?? null, f.about ?? null, f.due ?? null, f.sec ?? 30],
      )
    ).id,
  );
}

async function items(itemType?: string) {
  const { rows } = await pool.query(`select id, item_type, proposal, reason, interaction_id, status from review_queue where proposal->>'source' = 'followthrough' ${itemType ? "and item_type = $1" : ""} order by id`, itemType ? [itemType] : []);
  return rows as Array<{ id: number; item_type: string; proposal: Record<string, any>; reason: string; interaction_id: string; status: string }>;
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  ({ url } = await resetDatabase(server, "strout_vault_followthrough", { seed: true, storageDir: STORAGE, quiet: true }));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  mock = createMockServices([]);

  // Only what this file adds: the seed's own facts and proposals would crowd the per-run cap.
  await pool.query(`delete from facts`);
  await pool.query(`delete from review_queue`);
  const now = Date.now();
  // The seed already has Ben (by OWNER_EMAILS); the step must recognise that party as him.
  ids.ben = Number((await one<{ id: string }>(`select id from parties where 'ben@example.com' = any(emails) order by id limit 1`)).id);
  ids.dana = await party("Dana Waiting", ["dana@example.com"]);
  ids.tanner = await party("Tanner Builder", ["tanner@example.com"]);
  ids.pat = await party("Pat Overdue", ["pat@example.com"]);
  ids.sam = await party("Sam Nocontact");
  ids.quinn = await party("Quinn Quiet", [], ["+12055550199"]);
  ids.lena = await party("Lena Answered", ["lena@example.com"]);

  // Waiting on Ben: Dana's email five days ago, no reply anywhere since.
  ids.danaThread = await thread({
    kind: "email_thread",
    workspace: "another_story",
    title: "Question about the addition",
    messages: [
      { fromMe: true, speaker: "Ben", text: "Happy to help, what do you need?", at: new Date(now - 6 * DAY) },
      { fromMe: false, partyId: ids.dana, speaker: "Dana Waiting", text: "Can you tell me if my roof can carry a second story?", at: new Date(now - 5 * DAY), from: "dana@example.com" },
    ],
  });
  // Not waiting: Lena wrote, Ben answered in the same thread.
  await thread({
    kind: "email_thread",
    workspace: "another_story",
    title: "Thanks",
    messages: [
      { fromMe: false, partyId: ids.lena, speaker: "Lena Answered", text: "Got the report, thanks.", at: new Date(now - 5 * DAY), from: "lena@example.com" },
      { fromMe: true, speaker: "Ben", text: "Glad it helped.", at: new Date(now - 4 * DAY) },
    ],
  });
  // Not waiting: an unknown sender (goes to Review as a new person instead), and a personal thread.
  await thread({ kind: "text_thread", workspace: "another_story", title: "Texts with +1 205", messages: [{ fromMe: false, speaker: "+12055550100", text: "Is this Ben?", at: new Date(now - 5 * DAY) }] });
  await thread({ kind: "text_thread", workspace: "personal", title: "Texts with Dana", messages: [{ fromMe: false, partyId: ids.dana, speaker: "Dana Waiting", text: "Dinner?", at: new Date(now - 5 * DAY) }] });

  // Gone quiet: Quinn is an open lead; Ben's text ten days ago is the last word.
  await pool.query(`insert into lead_records (origin, origin_id, party_id, workspace_id, lead_type, status) values ('platform_leads', 'quinn-1', $1, 'another_story', 'homeowner', 'new')`, [ids.quinn]);
  ids.quinnThread = await thread({
    kind: "text_thread",
    workspace: "another_story",
    title: "Texts with Quinn Quiet",
    messages: [
      { fromMe: false, partyId: ids.quinn, speaker: "Quinn Quiet", text: "Interested in a second story.", at: new Date(now - 12 * DAY) },
      { fromMe: true, speaker: "Ben", text: "Great, want to book a call this week?", at: new Date(now - 10 * DAY) },
    ],
  });

  // Commitments made on a call ten days ago.
  ids.call = Number(
    (await one<{ id: string }>(`insert into interactions (workspace_id, kind, title, occurred_at, source) values ('another_story', 'meeting', 'Tanner: weekly call', $1, 'test') returning id`, [new Date(now - 10 * DAY)])).id,
  );
  await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, 0, 30, 35, 'Ben', 'I will send you the vetted floor plans')`, [ids.call]);
  for (const p of [ids.tanner, ids.pat, ids.sam]) await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2)`, [ids.call, p]);
  ids.keptFact = await fact({ interactionId: ids.call, text: "Ben will send Tanner the vetted floor plans.", owner: ids.ben, about: ids.tanner });
  ids.overdueFact = await fact({ interactionId: ids.call, text: "Pat will send Ben the site survey.", owner: ids.pat, about: ids.ben, due: new Date(now - 2 * DAY).toISOString().slice(0, 10) });
  ids.staleFact = await fact({ interactionId: ids.call, text: "Ben will introduce Sam to the engineer.", owner: ids.ben, about: ids.sam });
  ids.decision = await fact({ interactionId: ids.call, text: "They are going with the metal roof.", kind: "decision" });
  // Undated, never mentioned again, but Ben and Mo have talked since: that is contact, not a stale commitment.
  ids.mo = await party("Mo Called", ["mo@example.com"]);
  await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2)`, [ids.call, ids.mo]);
  ids.contactedFact = await fact({ interactionId: ids.call, text: "Ben will price the dormer option for Mo.", owner: ids.ben, about: ids.mo });
  const later = Number(
    (await one<{ id: string }>(`insert into interactions (workspace_id, kind, title, occurred_at, source) values ('another_story', 'call', 'Call with Mo', $1, 'test') returning id`, [new Date(now - 2 * DAY)])).id,
  );
  await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, 0, 5, 9, 'Mo Called', 'How was the game on Saturday?')`, [later]);
  await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, $2)`, [later, ids.mo]);
  // Tanner later: Ben's email says the plans went out.
  ids.tannerThread = await thread({
    kind: "email_thread",
    workspace: "another_story",
    title: "Floor plans",
    messages: [
      { fromMe: true, speaker: "Ben", text: "I sent the floor plans over this morning, take a look.", at: new Date(now - 3 * DAY) },
      { fromMe: false, partyId: ids.tanner, speaker: "Tanner Builder", text: "Got them, thanks!", at: new Date(now - 3 * DAY + 3600_000), from: "tanner@example.com" },
    ],
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
});

describe("follow-through step", () => {
  it("is off without a budget: counts what it would look at and calls nobody", async () => {
    const r = await runWorker(makeCtx(makeConfig({ FOLLOWTHROUGH_MONTHLY_BUDGET_USD: "0" })), { trigger: "test", steps: ["followthrough"] });
    expect(r.summary.followthrough).toMatchObject({ configured: false, candidates: { replies: 2, commitments: 4, quiet: 1 }, calls: 0 });
    expect(mock.followthroughRequests).toHaveLength(0);
    expect(await items()).toHaveLength(0);
    expect(formatRunSummary(r.summary)).toMatch(/^followthrough: off \(2 waiting on a reply, 4 open commitment\(s\), 1 gone quiet\)$/m);
  });

  it("queues the reply Dana is waiting on, with a draft in the same email thread", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["followthrough"] });
    const s = r.summary.followthrough!;
    expect(s).toMatchObject({ configured: true, failed: 0, queued: { replies: 1, done: 1, nudges: 3 }, skippedNoReply: 1 });
    expect(s.spentUsd).toBeGreaterThan(0);

    const replies = await items("reply_needed");
    // Tanner's "Got them, thanks!" needs no answer: recorded as Claude's call, closed, never asked again.
    const thanks = replies.find((x) => Number(x.interaction_id) === ids.tannerThread)!;
    expect(thanks).toMatchObject({ status: "rejected", proposal: { no_reply_needed: true } });
    expect(thanks.reason).toBe("Tanner Builder's last message needs no reply (Claude's call)");
    const reply = replies.find((x) => x.status === "open")!;
    expect(Number(reply.interaction_id)).toBe(ids.danaThread);
    expect(reply.proposal).toMatchObject({
      party_id: ids.dana,
      last_message_idx: 1,
      draft: { channel: "email", to: "dana@example.com", subject: "Mock subject" },
      thread_ref: { source: "gmail", message_id: "msg-1" },
      source: "followthrough",
    });
    expect(reply.proposal.draft.body).toMatch(/^Mock draft: Reply to Dana Waiting/);
    expect(reply.reason).toMatch(/^Dana Waiting wrote .* no reply for \d+ weekday hour\(s\)$/);
    const req = mock.followthroughRequests.find((x) => x.kind === "draft" && x.user.includes("Dana Waiting"))!;
    expect(req.user).toContain("Can you tell me if my roof can carry a second story?");
    expect(req.model).toBe("claude-opus-5-5");
  });

  it("calls a commitment kept only with a later message to show, and points at it", async () => {
    const [done] = await items("fact_status");
    expect(done.proposal).toMatchObject({ fact_id: ids.keptFact, status: "done", interaction_id: ids.tannerThread, party_id: ids.tanner, quote_start_sec: 0 });
    expect(done.reason).toMatch(/^“Ben: I sent the floor plans over this morning/);
    const check = mock.followthroughRequests.find((x) => x.kind === "done" && x.user.includes("vetted floor plans"))!;
    expect(check.user).toMatch(new RegExp(`^Conversation ${ids.tannerThread} \\(email thread, Floor plans`, "m"));
    expect((await one(`select followup_checked_at from facts where id = $1`, [ids.keptFact])).followup_checked_at).not.toBeNull();
  });

  it("nudges what is overdue, what went stale, and who went quiet; decisions are never nudged", async () => {
    const nudges = await items("nudge");
    const byReason = Object.fromEntries(nudges.map((n) => [n.proposal.reason, n]));
    expect(Object.keys(byReason).sort()).toEqual(["overdue", "quiet", "stale"]);

    expect(byReason.overdue.proposal).toMatchObject({ fact_id: ids.overdueFact, party_id: ids.pat, owner_is_ben: false, draft: { channel: "email", to: "pat@example.com" } });
    expect(byReason.overdue.proposal.draft.body).toMatch(/Pat Overdue owe Ben this and it is past due/);
    expect(byReason.overdue.reason).toMatch(/^Pat Overdue commitment is overdue \(due \d{4}-\d{2}-\d{2}\)/);

    // Sam has no email or phone: a reminder without a draft.
    expect(byReason.stale.proposal).toMatchObject({ fact_id: ids.staleFact, party_id: ids.sam, owner_is_ben: true });
    expect(byReason.stale.proposal.draft).toBeUndefined();

    // Quinn last texted with Ben, so the nudge is a text to the number on file.
    expect(byReason.quiet.proposal).toMatchObject({ party_id: ids.quinn, interaction_id: ids.quinnThread, draft: { channel: "text", to: "+12055550199", subject: null } });
    expect(byReason.quiet.reason).toMatch(/^Quinn Quiet has not answered Ben's last message from 10 day\(s\) ago$/);

    expect(nudges.some((n) => n.proposal.fact_id === ids.decision)).toBe(false);
    expect(nudges.some((n) => n.proposal.fact_id === ids.contactedFact)).toBe(false);
    // The later call never mentions the dormer, so there was nothing to check and nothing was paid for.
    expect(mock.followthroughRequests.some((x) => x.kind === "done" && x.user.includes("dormer"))).toBe(false);
  });

  it("never queues the same thing twice, and does not pay to re-check the same evidence", async () => {
    const before = { items: (await items()).length, calls: mock.followthroughRequests.length };
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["followthrough"] });
    expect(r.summary.followthrough).toMatchObject({ queued: { replies: 0, done: 0, nudges: 0 }, calls: 0 });
    expect((await items()).length).toBe(before.items);
    expect(mock.followthroughRequests.length).toBe(before.calls);
  });

  it("stops at the budget", async () => {
    await pool.query(`delete from review_queue where proposal->>'source' = 'followthrough' and item_type = 'reply_needed'`);
    const r = await runWorker(makeCtx(makeConfig({ FOLLOWTHROUGH_MONTHLY_BUDGET_USD: "0.0000001" })), { trigger: "test", steps: ["followthrough"] });
    expect(r.summary.followthrough).toMatchObject({ waitingOnBudget: 1, stoppedEarly: "followthrough budget", calls: 0 });
    expect(await items("reply_needed")).toHaveLength(0);
    // Back under budget, both are looked at again on the next run.
    await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["followthrough"] });
    expect((await items("reply_needed")).map((x) => x.status).sort()).toEqual(["open", "rejected"]);
  });
});

describe("approving follow-through items", () => {
  it("fact_status closes the commitment and records the conversation that showed it", async () => {
    const [done] = await items("fact_status");
    const out = await decideReview(pool, done.id, "approve");
    expect(out.applied).toEqual([`facts #${ids.keptFact} done`]);
    const f = await one(`select status, closed_at, closed_by_interaction_id from facts where id = $1`, [ids.keptFact]);
    expect(f.status).toBe("done");
    expect(f.closed_at).not.toBeNull();
    expect(Number(f.closed_by_interaction_id)).toBe(ids.tannerThread);
  });

  it("a commitment that is no longer open fails with 400 and the item stays open", async () => {
    const id = Number(
      (await one<{ id: string }>(`insert into review_queue (item_type, proposal, reason, status) values ('fact_status', $1::jsonb, 'test', 'open') returning id`, [JSON.stringify({ fact_id: ids.keptFact, status: "done", source: "followthrough", key: "test-dup" })])).id,
    );
    await expect(decideReview(pool, id, "approve")).rejects.toMatchObject({ status: 400, message: `fact ${ids.keptFact} is already done` });
    expect((await one(`select status from review_queue where id = $1`, [id])).status).toBe("open");
  });

  it("a draft can be edited while the item is open, and approving a reply changes no record", async () => {
    const reply = (await items("reply_needed")).find((x) => x.status === "open")!;
    const edited = await updateDraft(pool, reply.id, { subject: "Re: your roof", body: "Dana, yes it can. [details] Ben" });
    expect(edited.proposal.draft).toMatchObject({ channel: "email", to: "dana@example.com", subject: "Re: your roof", body: "Dana, yes it can. [details] Ben", edited: true });
    const out = await decideReview(pool, reply.id, "approve");
    expect(out.applied).toEqual(["handled (send the draft yourself)"]);
    await expect(updateDraft(pool, reply.id, { body: "too late" })).rejects.toBeInstanceOf(ReviewError);
    const [stale] = (await items("nudge")).filter((n) => n.proposal.reason === "stale");
    await expect(updateDraft(pool, stale.id, { body: "x" })).rejects.toMatchObject({ status: 400, message: "this item has no draft to edit" });
  });

  it("a rejected nudge does not come back", async () => {
    const [quiet] = (await items("nudge")).filter((n) => n.proposal.reason === "quiet");
    await decideReview(pool, quiet.id, "reject");
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["followthrough"] });
    expect(r.summary.followthrough!.queued.nudges).toBe(0);
    expect((await items("nudge")).filter((n) => n.proposal.reason === "quiet")).toHaveLength(1);
  });
});
