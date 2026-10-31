// Phase 1 v2 end to end on its own local database: the classify step (mock Claude, phalanx guard,
// Gmail account, budget), extraction straight to facts with one fact for a promise made in two
// conversations, closing a fact from the recording page's endpoint, the link step (title names,
// close names as suggestions, "Call Recording" retitled from the number, Ben never linked), and
// the connector's scope through the MCP server: personal visible, phalanx and inbox never.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { loadConfig, type Config } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { runWorker, formatRunSummary } from "../../server/worker/run.ts";
import { CLASSIFY_SYSTEM_PROMPT } from "../../server/workspaces/classifyStep.ts";
import { FakeEmbeddingProvider } from "../../server/embeddings/fake.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { directUrl, tryAdvisoryLock } from "../../server/db/locks.ts";

const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-phase1");
const TMP = path.join(os.tmpdir(), "strout-vault-phase1-test");
const KEY = "anthropic-test-key";

let urls: { url: string; readerUrl: string; proposerUrl: string };
let pool: pg.Pool;
let storage: LocalStorageDriver;
let t: TestApp;
let http: Server;
let owner: Session;
const classifyRequests: string[] = [];
const extractRequests: Array<{ context: string; transcript: string }> = [];

/** Mock Claude: the classifier answers from keywords in each item; the extractor finds one promise per conversation. */
const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.host !== "anthropic.test" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}"));
  const system = Array.isArray(body.system) ? body.system[0]?.text : body.system;
  const blocks = (body.messages?.[0]?.content ?? []) as Array<{ text: string }>;
  const usage = { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = (out: unknown) =>
    new Response(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (system === CLASSIFY_SYSTEM_PROMPT) {
    const text = blocks.map((b) => b.text).join("\n");
    classifyRequests.push(text);
    const items = [...text.matchAll(/<item id="(\d+)">([\s\S]*?)<\/item>/g)].map(([, id, item]) => {
      if (/dermatryx|wound care trial/i.test(item)) return { id: Number(id), workspace: "phalanx", confidence: 0.9, reason: "phalanx product", phalanx_material: true, other_party: null };
      if (/\bmom\b|soccer practice/i.test(item)) return { id: Number(id), workspace: "personal", confidence: 0.92, reason: "family", phalanx_material: false, other_party: null };
      if (/kitchen addition|permit set/i.test(item)) return { id: Number(id), workspace: "strout_arch", confidence: 0.86, reason: "design client", phalanx_material: false, other_party: /this is Kevin/i.test(item) ? "Kevin McGuire" : null };
      return { id: Number(id), workspace: "another_story", confidence: 0.45, reason: "unclear", phalanx_material: false, other_party: null };
    });
    return reply({ items });
  }
  // Extractor.
  const context = blocks[0]?.text ?? "";
  const transcript = blocks[1]?.text ?? "";
  extractRequests.push({ context, transcript });
  const stamps = [...transcript.matchAll(/^\[(\d{2}):(\d{2}):(\d{2})\] (.*)$/gm)].map((m) => ({ sec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), line: m[4] }));
  const promise = stamps.find((s) => /survey/i.test(s.line));
  const open = [...context.matchAll(/^- (\d+) · commitment · (.*) · /gm)].find((m) => /survey/i.test(m[2]));
  const facts = promise
    ? [
        {
          kind: "commitment",
          text: "Ben will send Dana Whitfield the survey by Friday",
          owner_party_id: null,
          about_party_id: null,
          project_id: null,
          amount: null,
          due_text: "Friday",
          due_date: "2030-01-01",
          quote_start_sec: promise.sec,
          quote: promise.line.replace(/^[^:]{1,40}: /, ""),
          same_as_fact_id: open ? Number(open[1]) : null,
          confidence: 0.9,
        },
        { kind: "task", text: "Someone might look at tile someday", owner_party_id: null, about_party_id: null, project_id: null, amount: null, due_text: null, due_date: null, quote_start_sec: promise.sec, quote: "maybe", same_as_fact_id: null, confidence: 0.65 },
      ]
    : [];
  return reply({ facts, speakers: [], projects: [] });
};

function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: urls.url,
    SESSION_SECRET: "test-secret-test-secret-test-secret",
    ADMIN_EMAIL: "owner@test.local",
    ADMIN_PASSWORD_HASH: "$2b$12$n.14Mj6k0QzvENVWdt4cSuCT51Njj30l5Hsv60FoeGYekXVMpWypO",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: STORAGE,
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_API_URL: "https://anthropic.test",
    CLASSIFY_MONTHLY_BUDGET_USD: "5",
    EXTRACT_MONTHLY_BUDGET_USD: "5",
    OWNER_EMAILS: "ben@example.com",
    ...overrides,
  });
}

function makeCtx(config: Config): WorkerContext {
  return { config, pool, storage, fetchImpl, sleep: async () => {}, now: () => new Date(), log: () => {}, tmpDir: TMP, tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }, deadline: Date.now() + 10 * 60_000, bytesBudget: 1e12 };
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pool.query(sql, params)).rows[0] as T;
}

async function add(fields: { workspace_id: string | null; kind: string; title: string; occurred_at?: Date; source?: string; payload?: Record<string, unknown>; raw?: unknown[] }, lines: Array<[string, string]>): Promise<number> {
  const r = await one<{ id: number }>(
    `insert into interactions (workspace_id, kind, title, occurred_at, source, source_payload, participants_raw) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) returning id`,
    [fields.workspace_id, fields.kind, fields.title, fields.occurred_at ?? new Date(Date.now() - 86_400_000), fields.source ?? "test", JSON.stringify(fields.payload ?? {}), JSON.stringify(fields.raw ?? [])],
  );
  let idx = 0;
  for (const [speaker, text] of lines) {
    await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, $2, $3, $3, $4, $5)`, [r.id, idx, idx * 60, speaker || null, text]);
    idx++;
  }
  return Number(r.id);
}

const ids: Record<string, number> = {};

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  urls = await resetDatabase(server, "strout_vault_phase1", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });
  // Everything the seed holds counts as already classified, linked and extracted: only what these tests add is new.
  await pool.query(`update interactions set classified_at = now(), linked_at = now(), extracted_at = now()`);
  t = await buildTestApp(
    { DATABASE_URL: urls.url, LOCAL_STORAGE_DIR: STORAGE, PUBLIC_URL: BASE, MCP_READER_DATABASE_URL: urls.readerUrl, MCP_PROPOSER_DATABASE_URL: urls.proposerUrl, EMBEDDING_PROVIDER: "fake", LOGIN_RATE_LIMIT_MAX: "200" },
    { mcp: { embeddings: new FakeEmbeddingProvider() } },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
}, 180_000);

afterAll(async () => {
  http?.closeAllConnections();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  await t?.close();
  await pool?.end();
});

describe("classify step", () => {
  beforeAll(async () => {
    ids.family = await add({ workspace_id: "inbox", kind: "note", title: "Saturday", source: "apple_note" }, [["", "Mom wants us at soccer practice by 9, bring snacks."]]);
    ids.storyMail = await add({ workspace_id: "inbox", kind: "email_thread", title: "Intro consultation", source: "gmail", payload: { account: "ben@anotherstory.com" } }, [["Logan", "Please select a time for your intro consultation."]]);
    ids.dermatryx = await add({ workspace_id: "inbox", kind: "recording", title: "Lab notes", source: "voice_memo" }, [["", "The Dermatryx samples shipped."], ["", "Dermatryx batch two next week."]]);
    ids.passing = await add({ workspace_id: "another_story", kind: "meeting", title: "Lindsey Walters Onboarding", source: "zoom" }, [["Ben", "Does he have his own company? It's called Shingle X."], ["Lindsey", "We want a second story."]]);
    ids.woundCare = await add({ workspace_id: "another_story", kind: "text_thread", title: "Texts with Greg", source: "imessage" }, [["Greg", "We still don't have the money for the wound care trial"]]);
    ids.zoomKitchen = await add({ workspace_id: null, kind: "meeting", title: "Ben Strout's Zoom Meeting", source: "zoom" }, [["", "Let's go over the kitchen addition and the permit set."]]);
    ids.vague = await add({ workspace_id: null, kind: "meeting", title: "Ben Strout's Zoom Meeting", source: "zoom" }, [["", "Can you hear me? Okay, great."]]);
  });

  it("without a budget files only what the deterministic signals settle and leaves the rest waiting", async () => {
    const r = await runWorker(makeCtx(makeConfig({ CLASSIFY_MONTHLY_BUDGET_USD: "0" })), { trigger: "test", steps: ["classify"] });
    const c = r.summary.classify!;
    expect(c.configured).toBe(false);
    expect(classifyRequests).toHaveLength(0);
    const ws = async (id: number) => (await one<{ workspace_id: string | null; classified_at: Date | null }>(`select workspace_id, classified_at from interactions where id = $1`, [id]));
    expect(await ws(ids.storyMail)).toMatchObject({ workspace_id: "another_story" });
    expect((await ws(ids.storyMail)).classified_at).not.toBeNull();
    expect(await ws(ids.dermatryx)).toMatchObject({ workspace_id: "phalanx" }); // two strong lines: no Claude needed
    expect(await ws(ids.passing)).toMatchObject({ workspace_id: "inbox", classified_at: null }); // out of a readable workspace now, read later
    expect((await ws(ids.family)).classified_at).toBeNull();
    expect(c.waitingOnBudget).toBeGreaterThan(0);
    expect(formatRunSummary(r.summary)).toMatch(/^classify: .*\(off: set CLASSIFY_MONTHLY_BUDGET_USD\)/m);
  });

  it("with Claude files the rest, guards phalanx, queues borderline items for review and records the spend", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["classify"] });
    const c = r.summary.classify!;
    expect(c.configured).toBe(true);
    expect(classifyRequests.length).toBeGreaterThan(0);
    expect(classifyRequests[0]).toMatch(/text \(first 2000 characters\):/);
    const row = (id: number) => one<{ workspace_id: string; classify_confidence: number; classify_model: string | null; classify_evidence: Record<string, unknown> }>(`select workspace_id, classify_confidence, classify_model, classify_evidence from interactions where id = $1`, [id]);
    expect((await row(ids.family)).workspace_id).toBe("personal");
    expect((await row(ids.zoomKitchen)).workspace_id).toBe("strout_arch");
    expect((await row(ids.zoomKitchen)).classify_model).toBe("claude-opus-5-5");
    expect((await row(ids.vague)).workspace_id).toBeNull(); // 0.45: not filed, stays unassigned with a review item
    // A passing "Shingle X" in an AnotherStory onboarding: out of another_story, into inbox, with a phalanx review item.
    expect((await row(ids.passing)).workspace_id).toBe("inbox");
    const review = await pool.query(`select proposal from review_queue where interaction_id = $1 and item_type = 'interaction_workspace' and status = 'open'`, [ids.passing]);
    expect(review.rows[0].proposal).toMatchObject({ workspace_id: "phalanx", source: "classifier" });
    // "wound care" in a filed thread, and Claude says phalanx material: moved out of another_story.
    expect(["inbox", "phalanx"]).toContain((await row(ids.woundCare)).workspace_id);
    const spend = await one<{ n: number; usd: number }>(`select count(*)::int as n, coalesce(sum(usd), 0)::float8 as usd from spend_ledger where provider = 'anthropic-classify'`);
    expect(spend.n).toBeGreaterThan(0);
    expect(spend.usd).toBeGreaterThan(0);
    // Every candidate is classified once: nothing is read again.
    const again = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["classify"] });
    expect(again.summary.classify!.candidates).toBe(0);
  });
});

describe("worker locks", () => {
  it("are held on a direct connection, exclusive while held, and free again after release", async () => {
    expect(directUrl("postgres://u:p@ep-cool-name-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require")).toBe("postgres://u:p@ep-cool-name-123.us-east-1.aws.neon.tech/neondb?sslmode=require");
    const a = await tryAdvisoryLock(pool, "phase1-test-lock");
    expect(a).not.toBeNull();
    expect(await tryAdvisoryLock(pool, "phase1-test-lock")).toBeNull();
    await a!.release();
    const b = await tryAdvisoryLock(pool, "phase1-test-lock");
    expect(b).not.toBeNull();
    await b!.release();
    const held = await one<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = hashtext('phase1-test-lock')::oid`);
    expect(held.n).toBe(0);
  });
});

describe("refile after the phalanx guard", () => {
  it("never refiles an item the guard parked in inbox, even when its people are known", async () => {
    // Kevin McGuire (party 2) has an another_story role in the seed: refile would file this thread there.
    const parked = await add({ workspace_id: "inbox", kind: "text_thread", title: "Texts with Kevin", source: "imessage" }, [["Kevin", "We still don't have the money for the wound care"]]);
    const plain = await add({ workspace_id: "inbox", kind: "text_thread", title: "Texts with Kevin, again", source: "imessage" }, [["Kevin", "See you Monday at the site"]]);
    for (const id of [parked, plain]) await pool.query(`insert into interaction_participants (interaction_id, party_id) values ($1, 2)`, [id]);
    await pool.query(`update interactions set classified_at = now(), classify_evidence = '{"phalanx": true, "decision": "inbox"}' where id = $1`, [parked]);
    await pool.query(`update interactions set classified_at = now() where id = $1`, [plain]);
    await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["refile"] });
    const ws = async (id: number) => (await one<{ workspace_id: string }>(`select workspace_id from interactions where id = $1`, [id])).workspace_id;
    expect(await ws(parked)).toBe("inbox");
    expect(await ws(plain)).not.toBe("inbox");
  });
});

describe("extraction to facts", () => {
  it("writes confident facts as open facts, links the same promise from a second conversation, and resolves Friday from the day it was said", async () => {
    // Wednesday 2026-10-28 (Chicago): "Friday" is 2026-10-30.
    const wed = new Date("2026-10-28T15:00:00Z");
    // Only the two conversations below are new to the extractor.
    await pool.query(`update interactions set extracted_at = coalesce(extracted_at, now()), extracted_through_idx = 100000`);
    const call = await add({ workspace_id: "another_story", kind: "call", title: "Call with Dana Whitfield", occurred_at: wed, source: "iphone_call" }, [["Dana", "When can I see it?"], ["Ben", "I'll send you the survey by Friday."]]);
    const text = await add({ workspace_id: "another_story", kind: "text_thread", title: "Texts with Dana Whitfield", occurred_at: new Date("2026-10-29T14:00:00Z"), source: "imessage" }, [["Ben", "Survey coming your way Friday like I said"]]);
    await pool.query(`update interactions set classified_at = now() where id = any($1::bigint[])`, [[call, text]]);
    ids.call = call;
    const r = await runWorker(makeCtx(makeConfig({ EXTRACT_MAX_PER_RUN: "5", EXTRACT_RECENT_DAYS: "3650", EXTRACT_MAX_AGE_DAYS: "3650", EXTRACT_THREAD_DAYS: "3650" })), { trigger: "test", steps: ["extract"] });
    const x = r.summary.extract!;
    expect(x.read).toBe(2);
    expect(x.facts).toEqual({ created: 1, linked: 1 });
    expect(x.queued.facts).toBe(2); // the 0.65 "someday" item, once per conversation, goes to Review
    const facts = await pool.query(`select * from facts where interaction_id = any($1::bigint[])`, [[call, text]]);
    expect(facts.rowCount).toBe(1);
    const f = facts.rows[0];
    // The text (the newer one) is read first and creates the fact; the call joins it as a second source.
    expect(f).toMatchObject({ kind: "commitment", status: "open", due_date: "2026-10-30", origin: "extract", workspace_id: "another_story", interaction_id: text, quote: "Survey coming your way Friday like I said", message_idx: 0 });
    ids.fact = Number(f.id);
    const sources = await pool.query(`select interaction_id, quote, message_idx from fact_sources where fact_id = $1 order by interaction_id`, [f.id]);
    expect(sources.rows.map((s) => [Number(s.interaction_id), s.quote, s.message_idx])).toEqual([
      [call, "I'll send you the survey by Friday.", 1],
      [text, "Survey coming your way Friday like I said", 0],
    ]);
    // The second read was offered the open fact so the model could say it is the same one.
    expect(extractRequests[extractRequests.length - 1].context).toContain(`- ${f.id} · commitment · Ben will send Dana Whitfield the survey by Friday`);
    expect(formatRunSummary(r.summary)).toMatch(/1 fact\(s\) written \(\+1 linked to an existing fact\)/);
  });

  it("closes and reopens a fact from the recording page", async () => {
    const done = await owner.agent.post(`/api/facts/${ids.fact}/status`).set({ "x-csrf-token": owner.csrf }).send({ status: "done", interactionId: ids.call });
    expect(done.status, done.text).toBe(200);
    expect(done.body.fact).toMatchObject({ id: ids.fact, status: "done" });
    const rec = await owner.agent.get(`/api/interactions/${ids.call}`);
    expect(rec.body.facts.find((x: { id: number }) => x.id === ids.fact)).toMatchObject({ status: "done", sourceCount: 2, quote: "I'll send you the survey by Friday." });
    const reopened = await owner.agent.post(`/api/facts/${ids.fact}/status`).set({ "x-csrf-token": owner.csrf }).send({ status: "open" });
    expect(reopened.body.fact.status).toBe("open");
    expect((await owner.agent.post(`/api/facts/999999/status`).set({ "x-csrf-token": owner.csrf }).send({ status: "done" })).status).toBe(404);
    expect((await owner.agent.post(`/api/facts/${ids.fact}/status`).send({ status: "done" })).status).toBe(403); // no CSRF header
  });
});

describe("link step", () => {
  it("links title names exactly, suggests close names, retitles a Call Recording from its number, and never links Ben", async () => {
    const ryan = await one<{ id: number }>(`insert into parties (kind, name, emails) values ('person', 'Ryan Meagher', '{ryan@bvmhomes.example.com}') returning id`);
    const benjamin = await one<{ id: number }>(`insert into parties (kind, name) values ('person', 'Benjamin Schiavi') returning id`);
    const assessment = await add({ workspace_id: null, kind: "meeting", title: "Ryan Meagher : AnotherStory Assessment", source: "zoom" }, [["Ben Strout", "Hi Ryan"], ["Ryan Meagher", "Hi Ben"]]);
    const typo = await add({ workspace_id: null, kind: "meeting", title: "Bejamin Schiavi: AnotherStory Assessment", source: "zoom" }, [["", "hello"]]);
    const callRec = await add({ workspace_id: "inbox", kind: "call", title: "Call Recording", source: "iphone_call", raw: [{ kind: "phone", identifier: "+19365550142", name: null, party_id: null }] }, [["", "Hey Ben"]]);
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["link"] });
    const k = r.summary.link!;
    expect(k.zoomApi).toBe("off");
    const people = async (id: number) => (await pool.query(`select party_id from interaction_participants where interaction_id = $1 order by party_id`, [id])).rows.map((x) => Number(x.party_id));
    expect(await people(assessment)).toEqual([Number(ryan.id)]); // Ben (party 1) is on the transcript but never linked
    expect((await one<{ n: number }>(`select count(*)::int as n from segments where interaction_id = $1 and speaker_party_id = $2`, [assessment, ryan.id])).n).toBe(1);
    expect(await people(typo)).toEqual([]);
    const suggestion = await one<{ proposal: Record<string, unknown> }>(`select proposal from review_queue where interaction_id = $1 and item_type = 'participant_match'`, [typo]);
    expect(suggestion.proposal).toMatchObject({ party_id: Number(benjamin.id), source: "link" });
    expect(await people(callRec)).toEqual([2]); // Kevin McGuire's number in the seed
    expect((await one<{ title: string }>(`select title from interactions where id = $1`, [callRec])).title).toBe("Call with Kevin McGuire");
    expect(k).toMatchObject({ retitled: 1, suggested: 1 });
    // Linked once: the next run has nothing to do.
    expect((await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["link"] })).summary.link!.candidates).toBe(0);
  });
});

describe("connector scope through the MCP server", () => {
  let client: Client;
  beforeAll(async () => {
    // Ben's connector scope after Phase 1: the five ventures, unassigned, and now personal.
    const res = await owner.agent.post("/api/mcp/tokens").set({ "x-csrf-token": owner.csrf }).send({ name: "connector", workspaceScope: ["another_story", "strout_arch", "southern_shutter", "sepp", "credvault", "unassigned", "personal"] });
    expect(res.status, res.text).toBe(201);
    client = new Client({ name: "vitest", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${res.body.token}` } } }));
    // A phalanx fact and a personal fact.
    await pool.query(`insert into facts (interaction_id, workspace_id, kind, text, status) values ($1, 'phalanx', 'commitment', 'Send the Dermatryx deck to investors', 'open'), ($2, 'personal', 'task', 'Bring snacks to soccer practice', 'open')`, [ids.dermatryx, ids.family]);
  });
  afterAll(async () => {
    await client?.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);

  it("shows open commitments from readable workspaces with every source, and personal, never phalanx", async () => {
    const out = await call("list_open_commitments", { limit: 20 });
    const texts = out.items.map((i: { text: string }) => i.text);
    expect(texts).toContain("Ben will send Dana Whitfield the survey by Friday");
    expect(texts).not.toContain("Send the Dermatryx deck to investors");
    const personal = await call("list_open_commitments", { workspace: "personal" });
    expect(personal.items.map((i: { text: string }) => i.text)).toEqual(["Bring snacks to soccer practice"]);
    expect((await call("list_open_commitments", { workspace: "phalanx" })).note).toMatch(/not within this token's scope/);
    const survey = out.items.find((i: { text: string }) => /survey/.test(i.text));
    expect(survey.sources).toHaveLength(2);
    expect(survey.quote).toBe("Survey coming your way Friday like I said");
  });

  it("finds nothing for phalanx terms and refuses inbox and phalanx by name", async () => {
    for (const q of ["Dermatryx", "Shingle X", "Phalanx"]) {
      const out = await call("search_conversations", { query: q, mode: "keyword" });
      expect(out.count, q).toBe(0);
    }
    for (const workspace of ["inbox", "phalanx"]) {
      const out = await call("list_interactions", { workspace, limit: 5 });
      expect(out.count).toBe(0);
      expect(out.note).toMatch(/not within this token's scope/);
    }
    const personal = await call("list_interactions", { workspace: "personal", limit: 5 });
    expect(personal.count).toBeGreaterThan(0);
  });
});
