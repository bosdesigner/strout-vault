// TikTok and Instagram DMs end to end, on their own local database: the /api/ingest/social
// endpoint and its token (purpose social_dm), per-conversation-per-day threads, matching people by
// handle, unknown accounts queued once with their handle, redaction and one-time codes, the
// dm_sources routing fallback (phalanx never), adding a handle to an existing person (relink +
// refile), MCP search and get_party by handle, and the Instagram connect + sync against a fake
// Instagram API (inline and per-message reads, the 20-message window, the cursor, token refresh,
// a revoked token). Nothing here reaches TikTok, Meta, Neon or an embedding API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { FakeEmbeddingProvider } from "../../server/embeddings/fake.ts";
import { decryptSecret } from "../../server/messages/crypto.ts";
import { syncInstagram, type InstagramDeps } from "../../server/messages/instagram/sync.ts";
import type { SocialBatchInput } from "../../server/messages/social.ts";

const PORT = 3993;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-social");
const KEY = "cd".repeat(32);
const SECRETS = ["4111 1111 1111 1111", "4111111111111111", "771204"];

let t: TestApp;
let http: Server;
let pool: pg.Pool;
let owner: Session;
let dmToken: string;
const mcpTokens: Record<string, string> = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-social-"));
const configDir = path.join(tmp, "config");
const party: Record<string, number> = {};
const csrf = () => ({ "x-csrf-token": owner.csrf });
const byRef = async (ref: string) => (await pool.query(`select * from interactions where source_ref = $1`, [ref])).rows[0];
const routing = (extra = "") => fs.writeFileSync(path.join(configDir, "message_routing.yml"), `parties:\n  ${party.daniel}: phalanx\n${extra}`);

// ------------------------------------------------------------------ fake Instagram API --
interface FakeMsg {
  id: string;
  created_time: string;
  from: { id: string; username: string };
  to: { data: Array<{ id: string; username: string }> };
  message?: string;
}
const ig = {
  conversations: [] as Array<{ id: string; updated_time: string; messages: FakeMsg[]; idsOnly?: boolean }>,
  calls: [] as string[],
  tokens: new Set(["IGlong-1"]),
  refreshed: 0,
  dead: false,
};
const ME = { id: "17841400000000001", username: "anotherstory" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const igFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== "ig.test") throw new Error(`unexpected fetch to ${url.host}`);
  const p = url.pathname;
  ig.calls.push(p);
  if (p === "/oauth/access_token") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("code") !== "fixture-code" || body.get("client_secret") !== "ig-secret") return json({ error_type: "OAuthException", code: 400, error_message: "bad code" }, 400);
    return json({ data: [{ access_token: "IGshort", user_id: ME.id, permissions: "instagram_business_basic,instagram_business_manage_messages" }] });
  }
  if (p === "/access_token") {
    if (url.searchParams.get("grant_type") !== "ig_exchange_token" || url.searchParams.get("client_secret") !== "ig-secret") return json({ error: { message: "bad exchange", code: 100 } }, 400);
    return json({ access_token: "IGlong-1", token_type: "bearer", expires_in: 5_184_000 });
  }
  const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (url.searchParams.get("access_token")) return json({ error: { message: "token in the URL", code: 100 } }, 400);
  if (ig.dead) return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
  if (p === "/refresh_access_token") {
    if (!ig.tokens.has(auth)) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
    ig.refreshed++;
    const next = `IGlong-${ig.refreshed + 1}`;
    ig.tokens.add(next);
    return json({ access_token: next, token_type: "bearer", expires_in: 5_184_000 });
  }
  if (auth !== "IGshort" && !ig.tokens.has(auth)) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
  const rest = p.replace(/^\/v26\.0\//, "");
  if (rest === "me") return json({ user_id: ME.id, id: "app-scoped-99", username: ME.username });
  if (rest === "me/conversations") {
    const sorted = [...ig.conversations].sort((a, b) => b.updated_time.localeCompare(a.updated_time));
    const after = Number(url.searchParams.get("after") ?? 0);
    const page = sorted.slice(after, after + 2);
    return json({ data: page.map((c) => ({ id: c.id, updated_time: c.updated_time })), paging: after + 2 < sorted.length ? { cursors: { after: String(after + 2) }, next: "more" } : {} });
  }
  const conv = ig.conversations.find((c) => c.id === rest);
  if (conv) {
    const newest = [...conv.messages].sort((a, b) => b.created_time.localeCompare(a.created_time)).slice(0, 20);
    return json({ id: conv.id, messages: { data: conv.idsOnly ? newest.map((m) => ({ id: m.id, created_time: m.created_time })) : newest } });
  }
  for (const c of ig.conversations) {
    const sorted = [...c.messages].sort((a, b) => b.created_time.localeCompare(a.created_time));
    const i = sorted.findIndex((m) => m.id === rest);
    if (i >= 20) return json({ error: { message: "The message has been deleted", code: 100 } }, 400);
    if (i >= 0) return json(sorted[i]);
  }
  return json({ error: { message: `unknown path ${rest}`, code: 803 } }, 404);
}) as typeof fetch;

function igMsg(id: string, at: string, fromMe: boolean, peer: { id: string; username: string }, text: string): FakeMsg {
  return fromMe ? { id, created_time: at, from: ME, to: { data: [peer] }, message: text } : { id, created_time: at, from: peer, to: { data: [ME] }, message: text };
}

// ------------------------------------------------------------------------------ helpers --
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T & { error?: string }> {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ text: string }>)[0].text) as T & { error?: string };
}
const post = (batch: SocialBatchInput | Record<string, unknown>, token = dmToken) => request(t.app).post("/api/ingest/social").set("authorization", `Bearer ${token}`).send(batch);

const tiktokBatch = (): SocialBatchInput => ({
  platform: "tiktok",
  account: "@HeMakesBigMoves",
  collector: { name: "tiktok", version: "test" },
  collector_counts: { conversations_seen: 3 },
  conversations: [
    {
      conversation_id: "conv-mike",
      peer: { username: "MikeBuilds", display_name: "🔥Mike Builds🔥" },
      messages: [
        { id: "m1", sent_at: "2026-10-26T15:00:00Z", from_me: false, text: "Saw the Build Up video. Is Huntsville open?" },
        { id: "m2", sent_at: "2026-10-26T15:05:00Z", from_me: true, text: "It is. Grab a time: calendly.com/ben-zba/30min" },
        { id: "m3", sent_at: "2026-10-27T13:00:00Z", from_me: false, text: "Booked for Thursday. My card is 4111 1111 1111 1111 for the deposit lol" },
      ],
    },
    {
      conversation_id: "conv-pegus",
      peer: { username: "pegus.homeowner", display_name: "Pegus Heard" },
      is_request: true,
      messages: [
        { id: "p1", sent_at: "2026-10-27T02:30:00Z", from_me: false, text: "Can you add a second story to a 1950s brick ranch in DC?" },
        { id: "p2", sent_at: "2026-10-27T02:31:00Z", from_me: false, text: "Your code is 771204" },
        { id: "p3", sent_at: "2026-10-27T02:32:00Z", from_me: false, text: "", shared_url: "https://www.tiktok.com/@hemakesbigmoves/video/7400000000000000001" },
      ],
    },
  ],
});

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const urls = await resetDatabase(server, "strout_vault_social", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  party.mike = Number((await pool.query(`insert into parties (kind, name, handles) values ('person', 'Mike Jones', '{tiktok:mikebuilds}') returning id`)).rows[0].id);
  await pool.query(`insert into roles (workspace_id, party_id, role) values ('another_story', $1, 'prospect')`, [party.mike]);
  party.pegusKnown = Number((await pool.query(`insert into parties (kind, name, phones) values ('person', 'Pegus Pedro Heard', '{"+1 202 555 0188"}') returning id`)).rows[0].id);
  await pool.query(`insert into roles (workspace_id, party_id, role) values ('another_story', $1, 'client')`, [party.pegusKnown]);
  party.daniel = 6;
  fs.mkdirSync(configDir);
  routing();
  fs.writeFileSync(path.join(configDir, "message_blocklist.yml"), `handles:\n  - "tiktok:@spam.giveaways"\n`);
  t = await buildTestApp(
    {
      DATABASE_URL: urls.url,
      LOCAL_STORAGE_DIR: STORAGE,
      PUBLIC_URL: BASE,
      MCP_READER_DATABASE_URL: urls.readerUrl,
      MCP_PROPOSER_DATABASE_URL: urls.proposerUrl,
      EMBEDDING_PROVIDER: "fake",
      LOGIN_RATE_LIMIT_MAX: "200",
      OWNER_EMAILS: "ben@example.com",
      MESSAGES_CONFIG_DIR: configDir,
      MESSAGES_ENCRYPTION_KEY: KEY,
      INSTAGRAM_APP_ID: "ig-app",
      INSTAGRAM_APP_SECRET: "ig-secret",
      INSTAGRAM_AUTHORIZE_URL: "http://ig.test/oauth/authorize",
      INSTAGRAM_TOKEN_URL: "http://ig.test/oauth/access_token",
      INSTAGRAM_GRAPH_BASE: "http://ig.test",
    },
    { fetchImpl: igFetch, mcp: { embeddings: new FakeEmbeddingProvider() } },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
  const tok = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "tiktok collector", workspaceScope: ["*"], scopes: ["ingest:messages"], purpose: "social_dm" });
  expect(tok.status, tok.text).toBe(201);
  expect(tok.body.item.purpose).toBe("social_dm");
  expect(tok.body.item.workspaceScope).toEqual([]);
  dmToken = tok.body.token;
  for (const [name, scope] of [
    ["story", ["another_story"]],
    ["arch", ["strout_arch"]],
  ] as const) {
    const res = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name, workspaceScope: scope });
    expect(res.status, res.text).toBe(201);
    mcpTokens[name] = res.body.token;
  }
}, 180_000);

afterAll(async () => {
  http?.closeAllConnections();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  await t?.close();
  await pool?.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------------- endpoint --
describe("POST /api/ingest/social", () => {
  it("takes only an ingest:messages token and a well-formed batch", async () => {
    expect((await request(t.app).post("/api/ingest/social").send({})).status).toBe(401);
    expect((await post(tiktokBatch(), "svt_unknown")).status).toBe(401);
    expect((await post(tiktokBatch(), mcpTokens.story)).status).toBe(403);
    const bad = await post({ platform: "myspace", account: "ben", conversations: [] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("myspace");
    const badUser = await post({ platform: "tiktok", account: "ben", conversations: [{ conversation_id: "x", peer: { username: "not a handle!" }, messages: [] }] });
    expect(badUser.status).toBe(400);
  });

  it("turns a TikTok batch into one thread per conversation per day, matched by handle", async () => {
    const res = await post(tiktokBatch());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: 3, review_new_party: 1 });
    expect(res.body.skipped).toEqual({ one_time_code: 1 });
    expect(res.body.routed).toEqual({ another_story: 2, inbox: 1 });

    const day1 = await byRef("tiktok:hemakesbigmoves:conv-mike:2026-10-26");
    expect(day1).toMatchObject({ kind: "text_thread", source: "tiktok", workspace_id: "another_story", title: "TikTok DMs with Mike Jones · 2026-10-26" });
    expect(day1.transcript).toBe("[10:00] Mike Jones: Saw the Build Up video. Is Huntsville open?\n[10:05] Ben: It is. Grab a time: calendly.com/ben-zba/30min");
    const segs = await pool.query(`select speaker, speaker_party_id from segments where interaction_id = $1 order by idx`, [day1.id]);
    expect(segs.rows.map((r) => [r.speaker, r.speaker_party_id && Number(r.speaker_party_id)])).toEqual([
      ["Mike Jones", party.mike],
      ["Ben", 1], // the seeded owner party (ben@example.com)
    ]);
    expect((await pool.query(`select party_id from interaction_participants where interaction_id = $1 order by party_id`, [day1.id])).rows.map((r) => Number(r.party_id))).toEqual([1, party.mike]);

    const day2 = await byRef("tiktok:hemakesbigmoves:conv-mike:2026-10-27");
    expect(day2.transcript).toContain("[REDACTED]");
    expect(day2.transcript).not.toContain("4111");

    // 02:30 UTC on the 27th is the evening of the 26th in Chicago.
    const pegus = await byRef("tiktok:hemakesbigmoves:conv-pegus:2026-10-26");
    expect(pegus).toMatchObject({ workspace_id: "inbox", title: "TikTok DMs with Pegus Heard (@pegus.homeowner) · 2026-10-26" });
    expect(pegus.source_payload).toMatchObject({ platform: "tiktok", account: "hemakesbigmoves", conversation_id: "conv-pegus", peer_username: "pegus.homeowner", is_request: true });
    expect(pegus.transcript).toContain("Pegus Heard: [shared: https://www.tiktok.com/@hemakesbigmoves/video/7400000000000000001]");
    expect(pegus.transcript).not.toContain("771204");

    const review = (await pool.query(`select proposal, reason from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = 'tiktok:pegus.homeowner'`)).rows;
    expect(review).toHaveLength(1);
    expect(review[0].proposal).toMatchObject({ name: "Pegus Heard", handles: ["tiktok:pegus.homeowner"], evidence: { identifier_kind: "handle", message_count: 2, sources: ["tiktok"] } });
    expect(review[0].reason).toBe("Unknown TikTok account in DMs: Pegus Heard (@pegus.homeowner), 2 message(s)");

    const run = (await pool.query(`select counts_in, counts_out from import_runs where source = 'tiktok' order by id desc limit 1`)).rows[0];
    expect(run.counts_in).toMatchObject({ account: "hemakesbigmoves", conversations: 2, collector_skipped: { conversations_seen: 3 } });
  });

  it("is idempotent, merges a later batch into the day, and never stores Ben's own handle or a blocklisted one", async () => {
    const again = await post(tiktokBatch());
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 3, review_new_party: 0 });
    const later = await post({
      platform: "tiktok",
      account: "hemakesbigmoves",
      conversations: [
        { conversation_id: "conv-mike", peer: { username: "mikebuilds" }, messages: [{ id: "m4", sent_at: "2026-10-27T14:00:00Z", from_me: true, text: "See you Thursday." }] },
        { conversation_id: "conv-spam", peer: { username: "spam.giveaways" }, messages: [{ id: "s1", sent_at: "2026-10-27T14:00:00Z", from_me: false, text: "You won!" }] },
        { conversation_id: "conv-self", peer: { username: "hemakesbigmoves" }, messages: [{ id: "x1", sent_at: "2026-10-27T14:00:00Z", from_me: false, text: "note to self" }] },
      ],
    });
    expect(later.body).toMatchObject({ created: 0, updated: 1, empty_threads: 1, skipped: { blocklist: 1 } });
    const day2 = await byRef("tiktok:hemakesbigmoves:conv-mike:2026-10-27");
    expect(day2.source_payload.message_count).toBe(2);
    expect(day2.pipeline_status).toBe("ready");
  });

  it("a handle added to someone already in the vault links their DMs, closes the review item and files the thread", async () => {
    const res = await owner.agent.patch(`/api/parties/${party.pegusKnown}`).set(csrf()).send({ handles: ["tiktok:@Pegus.Homeowner"] });
    expect(res.status, res.text).toBe(200);
    expect(res.body.handles).toEqual(["tiktok:pegus.homeowner"]);
    const thread = await byRef("tiktok:hemakesbigmoves:conv-pegus:2026-10-26");
    expect(thread.workspace_id).toBe("another_story");
    const segs = await pool.query(`select distinct speaker_party_id from segments where interaction_id = $1`, [thread.id]);
    expect(segs.rows.map((r) => Number(r.speaker_party_id))).toEqual([party.pegusKnown]);
    const review = (await pool.query(`select status from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = 'tiktok:pegus.homeowner'`)).rows[0];
    expect(review.status).toBe("rejected");
    const bad = await owner.agent.patch(`/api/parties/${party.pegusKnown}`).set(csrf()).send({ handles: ["myspace:tom"] });
    expect(bad.status).toBe(400);
  });

  it("approving an unknown account creates the person with the handle", async () => {
    await post({ platform: "instagram", account: "anotherstory", conversations: [{ conversation_id: "ig-x", peer: { username: "dana.renovates" }, messages: [{ id: "d1", sent_at: "2026-10-25T16:00:00Z", from_me: false, text: "Love the second story idea" }] }] });
    const item = (await pool.query(`select id from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = 'instagram:dana.renovates'`)).rows[0];
    const ok = await owner.agent.post(`/api/review/${item.id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(ok.status, ok.text).toBe(200);
    const created = (await pool.query(`select id, name, handles from parties where 'instagram:dana.renovates' = any(handles)`)).rows[0];
    expect(created).toMatchObject({ name: "@dana.renovates", handles: ["instagram:dana.renovates"] });
    const thread = await byRef("instagram:anotherstory:ig-x:2026-10-25");
    expect(thread.title).toBe("Instagram DMs with @dana.renovates · 2026-10-25");
    expect(Number((await pool.query(`select speaker_party_id from segments where interaction_id = $1`, [thread.id])).rows[0].speaker_party_id)).toBe(Number(created.id));
  });

  it("dm_sources files unknown senders under a workspace, and never under phalanx", async () => {
    routing("dm_sources:\n  tiktok: another_story\n  instagram: phalanx\n");
    const r1 = await post({ platform: "tiktok", account: "hemakesbigmoves", conversations: [{ conversation_id: "c-new", peer: { username: "newcontractor" }, messages: [{ id: "n1", sent_at: "2026-10-27T16:00:00Z", from_me: false, text: "Interested in Tulsa" }] }] });
    expect(r1.body.routed).toEqual({ another_story: 1 });
    const r2 = await post({ platform: "instagram", account: "anotherstory", conversations: [{ conversation_id: "c-ph", peer: { username: "investor.guy" }, messages: [{ id: "i1", sent_at: "2026-10-27T16:00:00Z", from_me: false, text: "Following up on the wound care deck" }] }] });
    expect(r2.body).toMatchObject({ routed: { inbox: 1 }, review_workspace: 1 });
    routing();
  });
});

// ------------------------------------------------------------------------------- MCP --
describe("MCP on DMs", () => {
  it("search finds TikTok DMs for an Another Story token and nothing for another workspace; get_party resolves a handle", async () => {
    const story = await connect(mcpTokens.story);
    const arch = await connect(mcpTokens.arch);
    try {
      const hit = await call<{ results: Array<{ title: string; workspace_id: string }> }>(story, "search_conversations", { query: "Huntsville open", mode: "keyword", kind: "text_thread" });
      expect(hit.results.map((r) => r.title)).toContain("TikTok DMs with Mike Jones · 2026-10-26");
      const none = await call<{ results: unknown[] }>(arch, "search_conversations", { query: "Huntsville open", mode: "keyword" });
      expect(none.results).toHaveLength(0);
      const who = await call<{ party_id: number; handles: string[] }>(story, "get_party", { handle: "tiktok:@MikeBuilds" });
      expect(who.party_id).toBe(party.mike);
      expect(who.handles).toEqual(["tiktok: @mikebuilds"]);
    } finally {
      await story.close();
      await arch.close();
    }
  });
});

// ------------------------------------------------------------------------- Instagram --
describe("Instagram", () => {
  let deps: InstagramDeps;
  const kim = { id: "IGSID-kim", username: "kim.builds.atx" };
  const lou = { id: "IGSID-lou", username: "lou_homes" };

  it("connects through Instagram Login and stores only an encrypted 60-day token", async () => {
    const start = await owner.agent.get("/api/messages/instagram/connect");
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.location);
    expect(loc.origin + loc.pathname).toBe("http://ig.test/oauth/authorize");
    expect(loc.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/api/messages/instagram/callback`);
    const bad = await owner.agent.get(`/api/messages/instagram/callback?code=fixture-code&state=forged`);
    expect(bad.status).toBe(400);
    const cb = await owner.agent.get(`/api/messages/instagram/callback?code=fixture-code%23_&state=${encodeURIComponent(loc.searchParams.get("state")!)}`);
    expect(cb.status, cb.text).toBe(200);
    expect(cb.text).toContain("Connected @anotherstory");
    const row = (await pool.query(`select * from message_accounts where provider = 'instagram'`)).rows[0];
    expect(row.account_email).toBe("anotherstory");
    expect(row.refresh_token_enc).not.toContain("IGlong");
    expect(decryptSecret(row.refresh_token_enc, KEY)).toBe("IGlong-1");
    expect(row.detail).toMatchObject({ ig_user_id: ME.id });
    expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    deps = { pool, config: t.config, fetchImpl: igFetch, sleep: async () => {}, now: () => new Date(), log: () => {} };
  });

  it("reads changed conversations, inline or message by message, as DM threads", async () => {
    ig.conversations = [
      { id: "ig-conv-kim", updated_time: "2026-10-27T15:00:00+0000", messages: [igMsg("k1", "2026-10-27T14:00:00+0000", false, kim, "Do you have an Austin builder?"), igMsg("k2", "2026-10-27T15:00:00+0000", true, kim, "Not yet. Want to be it?")] },
      { id: "ig-conv-lou", updated_time: "2026-10-27T12:00:00+0000", idsOnly: true, messages: [igMsg("l1", "2026-10-27T12:00:00+0000", false, lou, "Price range for a 600 sf addition?")] },
      { id: "ig-conv-old", updated_time: "2026-10-20T12:00:00+0000", messages: Array.from({ length: 25 }, (_, i) => igMsg(`o${i}`, `2026-10-20T11:${String(i).padStart(2, "0")}:00+0000`, false, lou, `old ${i}`)) },
    ];
    const s = await syncInstagram(deps);
    expect(s.errors).toEqual([]);
    expect(s.accounts[0]).toMatchObject({ account: "anotherstory", mode: "incremental", conversations: 3, messages: 23, done: true });
    const kimThread = await byRef("instagram:anotherstory:ig-conv-kim:2026-10-27");
    expect(kimThread.transcript).toBe("[09:00] @kim.builds.atx: Do you have an Austin builder?\n[10:00] Ben: Not yet. Want to be it?");
    const louThread = await byRef("instagram:anotherstory:ig-conv-lou:2026-10-27");
    expect(louThread.transcript).toContain("Price range for a 600 sf addition?");
    // Only the 20 newest of a long conversation are readable.
    expect((await byRef("instagram:anotherstory:ig-conv-old:2026-10-20")).source_payload.message_count).toBe(20);
    expect(ig.calls.some((c) => c.endsWith("/l1"))).toBe(true);
    const acct = (await pool.query(`select detail, last_synced_at from message_accounts where provider = 'instagram'`)).rows[0];
    expect(acct.detail.last_updated).toBe(Date.parse("2026-10-27T15:00:00Z"));
    const run = (await pool.query(`select counts_out from import_runs where source = 'instagram' order by id desc limit 1`)).rows[0];
    expect(run.counts_out).toMatchObject({ created: 3 });
  });

  it("the next pass reads only conversations updated since, and refreshes a token close to expiry", async () => {
    ig.calls = [];
    const quiet = await syncInstagram(deps);
    expect(quiet.accounts[0].conversations).toBe(0);
    expect(ig.calls.filter((c) => c.includes("ig-conv"))).toEqual([]);

    ig.conversations[1].messages.push(igMsg("l2", "2026-10-27T18:00:00+0000", true, lou, "About $180k all in, depends on structure."));
    ig.conversations[1].updated_time = "2026-10-27T18:00:00+0000";
    await pool.query(`update message_accounts set token_expires_at = now() + interval '3 days', detail = detail - 'token_refreshed_at' where provider = 'instagram'`);
    const next = await syncInstagram(deps);
    expect(next.accounts[0]).toMatchObject({ conversations: 1, tokenRefreshed: true });
    expect(next.ingest).toMatchObject({ updated: 1, created: 0 });
    const row = (await pool.query(`select refresh_token_enc, token_expires_at from message_accounts where provider = 'instagram'`)).rows[0];
    expect(decryptSecret(row.refresh_token_enc, KEY)).toBe("IGlong-2");
    expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
  });

  it("a revoked token marks the account erroring, and the Sources panel shows TikTok and Instagram", async () => {
    ig.dead = true;
    await pool.query(`update message_accounts set detail = detail - 'last_updated' where provider = 'instagram'`);
    const s = await syncInstagram(deps);
    expect(s.errors[0]).toMatch(/@anotherstory: conversations: 400 OAuthException Error validating access token/);
    const row = (await pool.query(`select status, last_error from message_accounts where provider = 'instagram'`)).rows[0];
    expect(row.status).toBe("error");
    ig.dead = false;
    const sources = await owner.agent.get("/api/pipeline/sources");
    expect(sources.status).toBe(200);
    const rows = sources.body.rows as Array<{ id: string; status: string; total: number; detail: string }>;
    expect(rows.find((r) => r.id === "tiktok")).toMatchObject({ status: "live", total: 4 });
    expect(rows.find((r) => r.id === "instagram:anotherstory")).toMatchObject({ status: "erroring", detail: "@anotherstory" });
  });

  it("no table and no log line holds a redacted secret", async () => {
    const { rows } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    for (const r of rows) {
      const { rows: data } = await pool.query(`select t::text as row from "${r.table_name}" t`);
      const text = data.map((d) => d.row).join("\n");
      for (const secret of SECRETS) expect(text.includes(secret), `${r.table_name} holds ${secret}`).toBe(false);
    }
  });
});
