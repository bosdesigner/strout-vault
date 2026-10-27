// Texts and email end to end, on their own local database: the ingest endpoint and its token,
// the synthetic chat.db through the collector's reader, idempotency, redaction (no table and no
// log line holds a card number, an SSN or a one-time code), party matching across phone
// spellings, workspace routing (phalanx -> inbox, personal by rule), unknown senders queued once,
// MCP scoping for an Another Story token, the embedding hand-off, and the Gmail sync against a
// fake Gmail API (filters, quoted replies, thread updates, the expired-historyId fallback, the
// resumable backfill). Nothing here reaches Google, Neon or an embedding API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { FakeEmbeddingProvider } from "../../server/embeddings/fake.ts";
import { embedInteraction, listEmbedCandidates } from "../../server/embeddings/pipeline.ts";
import { encryptSecret } from "../../server/messages/crypto.ts";
import { backfillGmail, listGmailAccounts, syncGmail, type GmailDeps } from "../../server/messages/gmail/sync.ts";
import { emptyIngestSummary } from "../../server/messages/ingest.ts";
import type { CollectedMessage } from "../../collectors/imessage/lib.mjs";
import { FIXTURE_MESSAGES } from "../fixtures/imessage/chatdb.ts";
import type { GmailMessage, GmailThread } from "../../server/messages/gmail/parse.ts";

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-messages");
const KEY = "ab".repeat(32);
const SECRETS = ["482913", "4111 1111 1111 1111", "4111111111111111", "123-45-6789", "552901"];

let t: TestApp;
let http: Server;
let pool: pg.Pool;
let owner: Session;
let ingestToken: string;
const mcpTokens: Record<string, string> = {};
const fake = new FakeEmbeddingProvider();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-messages-"));
const party: Record<string, number> = { kevin: 2, daniel: 6, ben: 1 };

const csrf = () => ({ "x-csrf-token": owner.csrf });

// ---------------------------------------------------------------- fake Gmail --
const gmail = {
  threads: new Map<string, GmailThread>(),
  history: [] as string[],
  historyExpired: false,
  profileHistoryId: "900",
  listPages: [] as Array<{ threadIds: string[] }>,
  calls: [] as string[],
};
const b64 = (s: string) => Buffer.from(s).toString("base64url");
function gmsg(id: string, threadId: string, o: { from: string; to?: string; subject: string; body: string; at: string; labels?: string[]; headers?: Array<{ name: string; value: string }>; attachment?: string }): GmailMessage {
  return {
    id,
    threadId,
    labelIds: o.labels ?? ["INBOX"],
    internalDate: String(Date.parse(o.at)),
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: o.from }, { name: "To", value: o.to ?? "Ben Strout <ben@example.com>" }, { name: "Subject", value: o.subject }, ...(o.headers ?? [])],
      parts: [{ mimeType: "text/plain", body: { data: b64(o.body) } }, ...(o.attachment ? [{ mimeType: "application/pdf", filename: o.attachment, body: { size: 1234, attachmentId: "secret-attachment-id" } }] : [])],
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== "gmail.test") throw new Error(`unexpected fetch to ${url.host}`);
  gmail.calls.push(url.pathname);
  if (url.pathname === "/token") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("refresh_token") !== "1//fixture-refresh") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: "ya29.fixture", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
  }
  const p = url.pathname.replace("/gmail/v1/users/me/", "");
  if (p === "profile") return json({ emailAddress: "ben@example.com", historyId: gmail.profileHistoryId });
  if (p === "history") {
    if (gmail.historyExpired) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    return json({ history: gmail.history.map((threadId) => ({ messagesAdded: [{ message: { id: `x-${threadId}`, threadId } }] })), historyId: "950" });
  }
  if (p === "messages") {
    const page = Number(url.searchParams.get("pageToken") ?? 0);
    const cur = gmail.listPages[page] ?? { threadIds: [] };
    return json({ messages: cur.threadIds.map((threadId) => ({ id: `l-${threadId}`, threadId })), ...(page + 1 < gmail.listPages.length ? { nextPageToken: String(page + 1) } : {}) });
  }
  const m = /^threads\/(.+)$/.exec(p);
  if (m) {
    const th = gmail.threads.get(decodeURIComponent(m[1]));
    return th ? json(th) : json({ error: { code: 404 } }, 404);
  }
  return json({ error: "not found" }, 404);
}) as typeof fetch;

// --------------------------------------------------------------------- helpers --
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T & { error?: string }> {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ text: string }>)[0].text) as T & { error?: string };
}

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const tbl of ["interactions", "segments", "interaction_participants", "review_queue", "parties", "chunks"]) {
    out[tbl] = (await pool.query(`select count(*)::int as n from ${tbl}`)).rows[0].n;
  }
  return out;
}

/** Every text-ish column of every table, as one string per table. */
async function everyTableText(): Promise<Map<string, string>> {
  const { rows } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const out = new Map<string, string>();
  for (const r of rows) {
    const { rows: data } = await pool.query(`select t::text as row from "${r.table_name}" t`);
    out.set(r.table_name, data.map((d) => d.row).join("\n"));
  }
  return out;
}

/**
 * What the collector sends for the synthetic chat.db (tests/fixtures/imessage/collector-payload.json,
 * which tests/unit/messages.test.ts proves equal to readMessages() over that chat.db). A file rather
 * than a live read so this suite runs on Node 20, which has no node:sqlite.
 */
function collectorPayload(): CollectedMessage[] {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/imessage/collector-payload.json"), "utf8")) as CollectedMessage[];
}

/** Messages the collector would have dropped, sent straight to the endpoint: the server must drop them too. */
function rawUnfiltered(): CollectedMessage[] {
  return FIXTURE_MESSAGES.filter((m) => m.guid === "fx-s-1" || m.guid === "fx-o-1").map((m) => ({
    guid: m.guid,
    chat_guid: m.chat,
    chat_name: null,
    chat_participants: [m.handle!],
    service: "SMS",
    sent_at: new Date(m.at).toISOString(),
    is_from_me: false,
    handle: m.handle,
    text: m.text!,
    attachments: [],
  }));
}

async function postBatch(messages: CollectedMessage[], token = ingestToken) {
  return request(t.app).post("/api/ingest/messages").set("authorization", `Bearer ${token}`).send({ collector: { name: "imessage", version: "test" }, messages });
}

const byRef = async (ref: string) => (await pool.query(`select * from interactions where source_ref = $1`, [ref])).rows[0];

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const urls = await resetDatabase(server, "strout_vault_messages", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  // People the fixtures talk to: one number in three spellings, Daniel (phalanx) gets a phone, family.
  party.alex = Number((await pool.query(`insert into parties (kind, name, phones) values ('person', 'Alex Rivera', '{"(205) 555-0142"}') returning id`)).rows[0].id);
  await pool.query(`update parties set phones = array['214-555-0166'] where id = $1`, [party.daniel]);
  party.mom = Number((await pool.query(`insert into parties (kind, name, phones) values ('person', 'Carol Strout', '{"512.555.0111"}') returning id`)).rows[0].id);
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "message_routing.yml"), `parties:\n  ${party.mom}: personal\n  ${party.daniel}: phalanx\ndomains:\n  newclient.example.com: strout_arch\n`);
  fs.writeFileSync(path.join(configDir, "message_blocklist.yml"), `emails:\n  - noreply@bank.example.com\n`);
  t = await buildTestApp(
    {
      DATABASE_URL: urls.url,
      LOCAL_STORAGE_DIR: STORAGE,
      PUBLIC_URL: BASE,
      MCP_READER_DATABASE_URL: urls.readerUrl,
      MCP_PROPOSER_DATABASE_URL: urls.proposerUrl,
      EMBEDDING_PROVIDER: "fake",
      LOGIN_RATE_LIMIT_MAX: "200",
      OWNER_PHONES: "+1 713 555 0100",
      OWNER_EMAILS: "ben@example.com",
      MESSAGES_CONFIG_DIR: configDir,
      MESSAGES_ENCRYPTION_KEY: KEY,
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-secret",
      GOOGLE_OAUTH_TOKEN_URL: "http://gmail.test/token",
      GMAIL_API_BASE: "http://gmail.test/gmail/v1",
    },
    { fetchImpl: fakeFetch, mcp: { embeddings: fake } },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
  const ing = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "mac collector", workspaceScope: ["*"], scopes: ["ingest:messages"] });
  expect(ing.status, ing.text).toBe(201);
  expect(ing.body.item.workspaceScope).toEqual([]);
  expect(ing.body.item.scopes).toEqual(["ingest:messages"]);
  ingestToken = ing.body.token;
  for (const [name, scope] of [
    ["story", ["another_story"]],
    ["star", ["*"]],
    ["full", ["*", "phalanx", "personal", "inbox"]],
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

// ------------------------------------------------------------------ the token --
describe("the ingest:messages token", () => {
  it("is the only thing POST /api/ingest/messages accepts", async () => {
    expect((await request(t.app).post("/api/ingest/messages").send({ messages: [] })).status).toBe(401);
    expect((await postBatch([], "svt_unknown")).status).toBe(401);
    const mcpToken = await postBatch([], mcpTokens.full);
    expect(mcpToken.status).toBe(403);
    expect(mcpToken.body.error).toBe("insufficient_scope");
    const bad = await postBatch([{ guid: "x" } as unknown as CollectedMessage]);
    expect(bad.status).toBe(400);
  });

  it("cannot call MCP tools or read anything", async () => {
    const res = await request(t.app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${ingestToken}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect((await request(t.app).get("/api/interactions").set("authorization", `Bearer ${ingestToken}`)).status).toBe(401);
    const combo = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "x", workspaceScope: [], scopes: ["ingest:messages", "vault:read"] });
    expect(combo.status).toBe(400);
  });
});

// ------------------------------------------------------------ texts end to end --
describe("texts from the collector", () => {
  let before: Record<string, number>;
  let afterFirst: Record<string, number>;
  const logs: string[] = [];

  it("imports the synthetic chat.db; a second import of the same batch writes nothing", async () => {
    before = await rowCounts();
    const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(capture), vi.spyOn(console, "error").mockImplementation(capture), vi.spyOn(console, "warn").mockImplementation(capture)];
    const out = vi.spyOn(process.stdout, "write");
    try {
      const first = await postBatch([...collectorPayload(), ...rawUnfiltered()]);
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ ok: true, created: 9, updated: 0, unchanged: 0, empty_threads: 1 });
      expect(first.body.skipped).toEqual({ short_code: 1, one_time_code: 1 });
      expect(first.body.redactions).toBe(2);
      afterFirst = await rowCounts();
      const second = await postBatch([...collectorPayload(), ...rawUnfiltered()]);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 9 });
      for (const call of out.mock.calls) logs.push(String(call[0]));
    } finally {
      spies.forEach((s) => s.mockRestore());
      out.mockRestore();
    }
    expect(await rowCounts()).toEqual(afterFirst);
    expect(afterFirst.interactions - before.interactions).toBe(9);
    expect(afterFirst.segments - before.segments).toBe(14);
    const runs = await pool.query(`select counts_in, counts_out from import_runs where source = 'imessage' order by id`);
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0].counts_out.skipped).toEqual({ short_code: 1, one_time_code: 1 });
    expect(runs.rows[1].counts_out.unchanged).toBe(9);
  });

  it("stores no card number, SSN or one-time code in any table or log line", async () => {
    const tables = await everyTableText();
    for (const [table, text] of tables) for (const s of SECRETS) expect(text.includes(s), `${s} found in ${table}`).toBe(false);
    const card = await pool.query(`select text from segments s join interactions i on i.id = s.interaction_id where i.source = 'imessage' and s.text like 'Card%'`);
    expect(card.rows[0].text).toBe("Card [REDACTED] exp 04/29, my SSN is [REDACTED]");
    for (const line of logs) for (const s of SECRETS) expect(line.includes(s), `${s} logged: ${line}`).toBe(false);
  });

  it("writes one text_thread per conversation per Chicago day, transcript as [HH:MM] Name: text", async () => {
    const day1 = await byRef("imessage:iMessage;-;+19365550142:2026-10-20");
    const day2 = await byRef("imessage:iMessage;-;+19365550142:2026-10-21");
    expect(day1.kind).toBe("text_thread");
    expect(day1.source).toBe("imessage");
    expect(day1.title).toBe("Texts with Kevin McGuire · 2026-10-20");
    expect(day1.transcript.split("\n")).toEqual([
      "[09:05] Kevin McGuire: Conroe shoot is moved to Thursday, the client wants golden hour",
      "[09:07] Ben: Works for me. Can you bring the drone?",
      "[09:09] Kevin McGuire: Yes, batteries charged",
      "[23:30] Kevin McGuire: Sent the Conroe shot list ✅",
    ]);
    expect(day1.pipeline_status).toBe("ready");
    expect(day1.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const segs = (await pool.query(`select idx, start_sec, speaker, speaker_party_id from segments where interaction_id = $1 order by idx`, [day1.id])).rows;
    expect(segs.map((s) => [s.idx, Number(s.start_sec), s.speaker, s.speaker_party_id === null ? null : Number(s.speaker_party_id)])).toEqual([
      [0, 0, "Kevin McGuire", party.kevin],
      [1, 150, "Ben", party.ben],
      [2, 240, "Kevin McGuire", party.kevin],
      [3, 51900, "Kevin McGuire", party.kevin],
    ]);
    expect(day2.source_payload.messages.find((m: { id: string }) => m.id === "fx-k-7").attachments).toEqual([{ filename: "IMG_0412.HEIC", mime: "image/heic", size: 2481337 }]);
    expect(day2.transcript).toContain("Kevin McGuire: Photo from the site");
  });

  it("resolves (205) 555-0142, +12055550142 and 205.555.0142 to the same party", async () => {
    const refs = ["imessage:SMS;-;(205) 555-0142:2026-10-20", "imessage:iMessage;-;205.555.0142:2026-10-20", "imessage:iMessage;-;+12055550142:2026-10-20"];
    for (const ref of refs) {
      const i = await byRef(ref);
      const ip = await pool.query(`select party_id from interaction_participants where interaction_id = $1 and party_id <> $2`, [i.id, party.ben]);
      expect(ip.rows.map((r) => Number(r.party_id))).toEqual([party.alex]);
      const s = await pool.query(`select distinct speaker_party_id from segments where interaction_id = $1`, [i.id]);
      expect(s.rows.map((r) => Number(r.speaker_party_id))).toEqual([party.alex]);
      expect(i.participants_raw[0].identifier).toBe("+12055550142");
    }
    expect((await pool.query(`select count(*)::int as n from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = '+12055550142'`)).rows[0].n).toBe(0);
  });

  it("routes: another_story by role, phalanx never automatic, personal by rule, unknown to inbox", async () => {
    expect((await byRef("imessage:iMessage;-;+19365550142:2026-10-20")).workspace_id).toBe("another_story");
    expect((await byRef("imessage:chat-group-0001:2026-10-20")).workspace_id).toBe("another_story");
    expect((await byRef("imessage:iMessage;-;+15125550111:2026-10-20")).workspace_id).toBe("personal");
    const phalanx = await byRef("imessage:iMessage;-;+12145550166:2026-10-20");
    expect(phalanx.workspace_id).toBe("inbox");
    const review = await pool.query(`select proposal, reason, status from review_queue where item_type = 'workspace_assignment' and interaction_id = $1`, [phalanx.id]);
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0].proposal).toMatchObject({ workspace_id: "phalanx", candidates: ["phalanx"] });
    expect(review.rows[0].reason).toMatch(/never assigned automatically/);
    const unknown = await byRef("imessage:iMessage;-;+17135550199:2026-10-20");
    expect(unknown.workspace_id).toBe("inbox");
    // Nobody known on it: it waits in inbox with no review item (it is filed once its people are known).
    expect((await pool.query(`select 1 from review_queue where item_type = 'workspace_assignment' and interaction_id = $1`, [unknown.id])).rowCount).toBe(0);
    expect((await byRef("imessage:SMS;-;48291:2026-10-20"))).toBeUndefined();
  });

  it("queues each unknown sender once for review and never creates a party", async () => {
    const q = await pool.query(`select proposal, interaction_id from review_queue where item_type = 'new_party' order by id`);
    const ids = q.rows.map((r) => r.proposal.evidence.identifier).sort();
    expect(ids).toEqual(["+15125550177", "+17135550199"]);
    const group = q.rows.find((r) => r.proposal.evidence.identifier === "+15125550177")!.proposal;
    expect(group).toMatchObject({ kind: "person", phones: ["+15125550177"], source: "messages", evidence: { identifier_kind: "phone", message_count: 1, first_seen: "2026-10-20T20:00:00.000Z", last_seen: "2026-10-20T20:00:00.000Z" } });
    expect((await rowCounts()).parties).toBe(afterFirst.parties);
    await postBatch(collectorPayload());
    expect((await pool.query(`select count(*)::int as n from review_queue where item_type = 'new_party'`)).rows[0].n).toBe(2);
  });

  it("merges a later batch into the same day's thread and re-triggers embedding", async () => {
    for (const c of await listEmbedCandidates(pool)) await embedInteraction(pool, fake, c.id);
    const ref = "imessage:iMessage;-;+19365550142:2026-10-20";
    const before1 = await byRef(ref);
    expect(before1.embedded_at).not.toBeNull();
    expect((await listEmbedCandidates(pool)).map((c) => c.id)).not.toContain(Number(before1.id));
    const res = await postBatch([{ guid: "fx-k-8", chat_guid: "iMessage;-;+19365550142", chat_name: null, chat_participants: ["+19365550142"], service: "iMessage", sent_at: "2026-10-20T15:00:00Z", is_from_me: false, handle: "+19365550142", text: "Also bring the gimbal", attachments: [] }]);
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    const after1 = await byRef(ref);
    expect(after1.id).toBe(before1.id);
    expect(after1.content_sha256).not.toBe(before1.content_sha256);
    expect(after1.transcript.split("\n")).toHaveLength(5);
    expect(after1.transcript.split("\n")[3]).toBe("[10:00] Kevin McGuire: Also bring the gimbal");
    expect((await listEmbedCandidates(pool)).map((c) => c.id)).toContain(Number(before1.id));
    await embedInteraction(pool, fake, Number(after1.id));
    // A body with a NUL byte (Postgres cannot store one) still lands, without it.
    const nul = await postBatch([{ guid: "fx-k-9", chat_guid: "iMessage;-;+19365550142", chat_name: null, chat_participants: ["+19365550142"], service: "iMessage", sent_at: "2026-10-20T15:30:00Z", is_from_me: false, handle: "+19365550142", text: "On my\u0000 way", attachments: [] }]);
    expect(nul.body).toMatchObject({ ok: true, updated: 1 });
    expect((await byRef(ref)).transcript).toContain("Kevin McGuire: On my way");
    await embedInteraction(pool, fake, Number(after1.id));
  });
});

// ------------------------------------------------------------------- MCP scope --
describe("MCP tools on texts", () => {
  it("an Another Story token finds Kevin's texts and nothing from personal, inbox or phalanx", async () => {
    for (const name of ["story", "star"]) {
      const client = await connect(mcpTokens[name]);
      try {
        const conroe = await call<{ results: Array<{ interaction_id: number; kind: string; workspace_id: string }> }>(client, "search_conversations", { query: "Conroe shoot drone", kind: "text_thread" });
        expect(conroe.results.length).toBeGreaterThan(0);
        expect(conroe.results.every((r) => r.kind === "text_thread" && r.workspace_id === "another_story")).toBe(true);
        for (const query of ["term sheet redlines data room", "Dinner Sunday", "Card exp SSN"]) {
          for (const mode of ["keyword", "semantic", "hybrid"]) {
            const r = await call<{ results: Array<{ workspace_id: string }> }>(client, "search_conversations", { query, mode });
            expect(r.results.filter((x) => ["personal", "inbox", "phalanx"].includes(x.workspace_id)), `${name} ${mode} ${query}`).toEqual([]);
          }
        }
        const list = await call<{ items: Array<{ workspace_id: string; kind: string }> }>(client, "list_interactions", { kind: "text_thread", limit: 50 });
        expect(list.items.length).toBeGreaterThan(0);
        expect(list.items.every((x) => !["personal", "inbox", "phalanx"].includes(x.workspace_id))).toBe(true);
        for (const ref of ["imessage:iMessage;-;+12145550166:2026-10-20", "imessage:iMessage;-;+15125550111:2026-10-20", "imessage:iMessage;-;+17135550199:2026-10-20"]) {
          const hidden = await byRef(ref);
          expect((await call(client, "get_interaction", { id: hidden.id })).error).toBe("not_found");
        }
        for (const ws of ["personal", "inbox", "phalanx"]) {
          const r = await call<{ count: number; note?: string }>(client, "list_interactions", { workspace: ws });
          expect(r.count).toBe(0);
          expect(r.note).toMatch(/not within this token's scope/);
        }
        // get_party: family (personal only) is invisible; Kevin's recent interactions carry no hidden thread.
        expect((await call(client, "get_party", { id: party.mom })).error).toBe("not_found");
        const kevin = await call<{ recent_interactions: Array<{ workspace_id: string }> }>(client, "get_party", { id: party.kevin });
        expect(kevin.recent_interactions.every((x) => !["personal", "inbox", "phalanx"].includes(x.workspace_id))).toBe(true);
      } finally {
        await client.close();
      }
    }
  });

  it("a token that names personal, inbox and phalanx sees them", async () => {
    const client = await connect(mcpTokens.full);
    try {
      const r = await call<{ results: Array<{ workspace_id: string }> }>(client, "search_conversations", { query: "term sheet redlines", mode: "keyword" });
      expect(r.results.map((x) => x.workspace_id)).toEqual(["inbox"]);
      const g = await call<{ transcript: { excerpt: { lines: Array<{ speaker: string; text: string }> } } }>(client, "get_interaction", { id: (await byRef("imessage:iMessage;-;+15125550111:2026-10-20")).id });
      expect(g.transcript.excerpt.lines[0]).toMatchObject({ speaker: "Carol Strout", text: "Dinner Sunday at 6?" });
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------- review --
describe("review decisions on message proposals", () => {
  it("approving an unknown sender creates the party and links their messages; approving a workspace files the thread", async () => {
    const item = (await pool.query(`select id from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = '+15125550177'`)).rows[0];
    const res = await owner.agent.post(`/api/review/${item.id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.applied.join(" ")).toMatch(/segments\.speaker_party_id \(1 message/);
    const created = (await pool.query(`select id from parties where phones @> '{+15125550177}'`)).rows[0];
    const group = await byRef("imessage:chat-group-0001:2026-10-20");
    const seg = await pool.query(`select speaker_party_id from segments where interaction_id = $1 and text like 'Who has%'`, [group.id]);
    expect(Number(seg.rows[0].speaker_party_id)).toBe(Number(created.id));
    const ws = (await pool.query(`select id from review_queue where item_type = 'workspace_assignment' and interaction_id = $1`, [(await byRef("imessage:iMessage;-;+12145550166:2026-10-20")).id])).rows[0];
    const ok = await owner.agent.post(`/api/review/${ws.id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(ok.status, ok.text).toBe(200);
    expect((await byRef("imessage:iMessage;-;+12145550166:2026-10-20")).workspace_id).toBe("phalanx");
  });

  it("an Inbox thread is filed once its person is known: approve them, give them a role (phalanx never)", async () => {
    const ref = "imessage:iMessage;-;+17135550199:2026-10-20";
    expect((await byRef(ref)).workspace_id).toBe("inbox");
    const item = (await pool.query(`select id from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = '+17135550199'`)).rows[0];
    const approved = await owner.agent.post(`/api/review/${item.id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(approved.status, approved.text).toBe(200);
    // Known now, but with no role anywhere: still nothing to file it under.
    expect((await byRef(ref)).workspace_id).toBe("inbox");
    const person = Number((await pool.query(`select id from parties where phones @> '{+17135550199}'`)).rows[0].id);
    // A phalanx role alone never files it.
    const ph = await owner.agent.post(`/api/parties/${person}/roles`).set(csrf()).send({ workspaceId: "phalanx", role: "prospect" });
    expect(ph.status, ph.text).toBe(201);
    expect((await byRef(ref)).workspace_id).toBe("inbox");
    // With the phalanx role gone, a Strout Architecture role files it.
    await pool.query(`delete from roles where party_id = $1 and workspace_id = 'phalanx'`, [person]);
    const sa = await owner.agent.post(`/api/parties/${person}/roles`).set(csrf()).send({ workspaceId: "strout_arch", role: "client" });
    expect(sa.status, sa.text).toBe(201);
    expect((await byRef(ref)).workspace_id).toBe("strout_arch");
  });
});

// ----------------------------------------------------------------------- Gmail --
describe("Gmail", () => {
  let deps: GmailDeps;
  beforeAll(async () => {
    await pool.query(`insert into message_accounts (provider, account_email, refresh_token_enc, scope) values ('gmail', 'ben@example.com', $1, 'https://www.googleapis.com/auth/gmail.readonly')`, [encryptSecret("1//fixture-refresh", KEY)]);
    deps = { pool, config: t.config, fetchImpl: fakeFetch, sleep: async () => {}, now: () => new Date(), log: () => {} };
    gmail.threads.set(
      "t-kevin",
      { id: "t-kevin", messages: [gmsg("g1", "t-kevin", { from: "Kevin McGuire <kevin.mcguire@example.com>", subject: "Conroe walkthrough", body: "Thursday works for the Conroe walkthrough.\n\nKevin\n--\nKevin McGuire | Camera & Drone", at: "2026-10-20T15:00:00Z", attachment: "shot-list.pdf" })] },
    );
    gmail.threads.set("t-promo", { id: "t-promo", messages: [gmsg("g2", "t-promo", { from: "Deals <deals@store.example.com>", subject: "50% off", body: "Sale", at: "2026-10-20T15:00:00Z", labels: ["INBOX", "CATEGORY_PROMOTIONS"] })] });
    gmail.threads.set("t-news", { id: "t-news", messages: [gmsg("g3", "t-news", { from: "News <news@paper.example.com>", subject: "Daily", body: "Headlines", at: "2026-10-20T15:00:00Z", headers: [{ name: "List-Unsubscribe", value: "<mailto:u@paper.example.com>" }] })] });
    gmail.threads.set("t-bank", { id: "t-bank", messages: [gmsg("g4", "t-bank", { from: "noreply@bank.example.com", subject: "Statement", body: "Your statement is ready", at: "2026-10-20T15:00:00Z" })] });
    gmail.threads.set("t-otp", { id: "t-otp", messages: [gmsg("g5", "t-otp", { from: "no-reply@accounts.example.com", subject: "Your verification code", body: "Your verification code is 552901", at: "2026-10-20T15:00:00Z" })] });
    gmail.threads.set("t-new", { id: "t-new", messages: [gmsg("g6", "t-new", { from: "Jane Park <jane@newclient.example.com>", subject: "Lake house addition", body: "Hi Ben, we'd like to talk about an addition.", at: "2026-10-21T13:00:00Z" })] });
  });

  it("initialises an account from the profile without fetching history", async () => {
    const s = await syncGmail(deps);
    expect(s.accounts).toEqual([expect.objectContaining({ mode: "initialized", threads: 0 })]);
    expect((await listGmailAccounts(pool))[0].historyId).toBe("900");
  });

  it("syncs from history.list: filters categories, List-Unsubscribe, blocklist and codes before storage", async () => {
    gmail.history = ["t-kevin", "t-promo", "t-news", "t-bank", "t-otp", "t-new"];
    const s = await syncGmail(deps);
    expect(s.errors).toEqual([]);
    expect(s.accounts[0]).toMatchObject({ mode: "history", threads: 6 });
    expect(s.ingest).toMatchObject({ created: 2, emptyThreads: 4 });
    expect(s.ingest.skipped).toEqual({ category_promotions: 1, list_unsubscribe: 1, blocklist: 1, one_time_code: 1 });
    expect((await listGmailAccounts(pool))[0].historyId).toBe("950");
    const run = (await pool.query(`select counts_out from import_runs where source = 'gmail' order by id desc limit 1`)).rows[0];
    expect(run.counts_out.skipped).toEqual({ category_promotions: 1, list_unsubscribe: 1, blocklist: 1, one_time_code: 1 });
    const kevin = await byRef("gmail:ben@example.com:t-kevin");
    expect(kevin).toMatchObject({ kind: "email_thread", source: "gmail", title: "Conroe walkthrough", workspace_id: "another_story" });
    expect(kevin.transcript).toBe("[10:00] Kevin McGuire: Thursday works for the Conroe walkthrough.\n\nKevin".replace("\n\n", " "));
    expect(kevin.source_payload.messages[0].attachments).toEqual([{ filename: "shot-list.pdf", mime: "application/pdf", size: 1234 }]);
    expect(JSON.stringify(kevin)).not.toContain("secret-attachment-id");
    expect((await byRef("gmail:ben@example.com:t-new")).workspace_id).toBe("strout_arch");
    const jane = (await pool.query(`select proposal from review_queue where item_type = 'new_party' and proposal->'evidence'->>'identifier' = 'jane@newclient.example.com'`)).rows[0];
    expect(jane.proposal).toMatchObject({ name: "Jane Park", emails: ["jane@newclient.example.com"], evidence: { sources: ["gmail"], message_count: 1 } });
    for (const s2 of SECRETS) expect([...(await everyTableText()).values()].join("\n")).not.toContain(s2);
  });

  it("a new message updates the same thread (quoted reply stripped) and re-triggers embedding", async () => {
    const before = await byRef("gmail:ben@example.com:t-kevin");
    await embedInteraction(pool, fake, Number(before.id));
    expect((await listEmbedCandidates(pool)).map((c) => c.id)).not.toContain(Number(before.id));
    gmail.threads.get("t-kevin")!.messages!.push(
      gmsg("g7", "t-kevin", {
        from: "Ben Strout <ben@example.com>",
        to: "Kevin McGuire <kevin.mcguire@example.com>",
        subject: "Re: Conroe walkthrough",
        body: "Great, see you at 4.\n\nOn Tue, Oct 20, 2026 at 10:00 AM Kevin McGuire <kevin.mcguire@example.com> wrote:\n> Thursday works for the Conroe walkthrough.\n",
        at: "2026-10-20T16:00:00Z",
        labels: ["SENT"],
      }),
    );
    gmail.history = ["t-kevin"];
    const s = await syncGmail(deps);
    expect(s.ingest).toMatchObject({ created: 0, updated: 1 });
    const after = await byRef("gmail:ben@example.com:t-kevin");
    expect(after.id).toBe(before.id);
    expect(after.transcript.split("\n")).toEqual(["[10:00] Kevin McGuire: Thursday works for the Conroe walkthrough. Kevin", "[11:00] Ben: Great, see you at 4."]);
    expect((await pool.query(`select count(*)::int as n from interactions where source_ref like 'gmail:ben@example.com:t-kevin%'`)).rows[0].n).toBe(1);
    expect((await listEmbedCandidates(pool)).map((c) => c.id)).toContain(Number(after.id));
  });

  it("falls back to messages.list when Google has expired the historyId", async () => {
    gmail.historyExpired = true;
    gmail.profileHistoryId = "1200";
    gmail.threads.set("t-late", { id: "t-late", messages: [gmsg("g8", "t-late", { from: "Kevin McGuire <kevin.mcguire@example.com>", subject: "Drone permit", body: "Permit approved for Conroe.", at: "2026-10-22T13:00:00Z" })] });
    gmail.listPages = [{ threadIds: ["t-late", "t-kevin"] }];
    const s = await syncGmail(deps);
    expect(s.accounts[0]).toMatchObject({ mode: "fallback", threads: 2 });
    expect(s.ingest).toMatchObject({ created: 1, unchanged: 1 });
    expect((await listGmailAccounts(pool))[0].historyId).toBe("1200");
    expect(await byRef("gmail:ben@example.com:t-late")).toBeTruthy();
    gmail.historyExpired = false;
  });

  it("backfills resumably; a dry run writes nothing at all", async () => {
    const account = (await listGmailAccounts(pool))[0];
    gmail.threads.set("t-old1", { id: "t-old1", messages: [gmsg("g9", "t-old1", { from: "Kevin McGuire <kevin.mcguire@example.com>", subject: "Spring shoot", body: "Old thread one", at: "2026-04-01T13:00:00Z" })] });
    gmail.threads.set("t-old2", { id: "t-old2", messages: [gmsg("g10", "t-old2", { from: "Kevin McGuire <kevin.mcguire@example.com>", subject: "Summer shoot", body: "Old thread two", at: "2026-06-01T13:00:00Z" })] });
    gmail.listPages = [{ threadIds: ["t-old1", "t-promo"] }, { threadIds: ["t-old2", "t-kevin"] }];
    const counts = await rowCounts();
    const dry = emptyIngestSummary(true);
    const d = await backfillGmail(deps, account, { sinceDays: 365, dryRun: true }, dry);
    expect(d).toMatchObject({ threads: 4, done: true });
    expect(dry).toMatchObject({ created: 2, unchanged: 1, emptyThreads: 1 });
    expect(await rowCounts()).toEqual(counts);
    expect((await pool.query(`select count(*)::int as n from worker_state where key like 'gmail_backfill:%'`)).rows[0].n).toBe(0);

    // A run that stops after the first page resumes on the second.
    const first = emptyIngestSummary();
    const r1 = await backfillGmail(deps, account, { sinceDays: 365, maxThreads: 2 }, first);
    expect(r1).toMatchObject({ threads: 2, done: false });
    expect(first.created).toBe(1);
    const state = (await pool.query(`select value from worker_state where key = $1`, [`gmail_backfill:${account.id}`])).rows[0].value;
    expect(state).toMatchObject({ page_token: "1", pages: 1, done: false });
    const second = emptyIngestSummary();
    const r2 = await backfillGmail(deps, account, { sinceDays: 365 }, second);
    expect(r2).toMatchObject({ threads: 2, done: true });
    expect(second).toMatchObject({ created: 1, unchanged: 1 });
    const again = emptyIngestSummary();
    expect(await backfillGmail(deps, account, { sinceDays: 365 }, again)).toMatchObject({ threads: 0, done: true });
  });
});
