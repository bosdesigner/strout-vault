// The MCP server end to end, on its own local database: personal tokens, OAuth 2.1 with PKCE
// and refresh rotation, workspace scope on every tool and every search mode, every tool
// against the seed, propose_update's single write, the audit log, the rate limit and the
// embedding worker step. Nothing here reaches Neon, R2 or an embedding API: the provider is
// the deterministic fake.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { ADMIN_EMAIL, ADMIN_PASSWORD, buildTestApp, lastMagicToken, login, type Session, type TestApp } from "../helpers.ts";
import { FakeEmbeddingProvider } from "../../server/embeddings/fake.ts";
import { embedInteraction, listEmbedCandidates, planInteraction } from "../../server/embeddings/pipeline.ts";
import { loadConfig } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import { processEmbeddings } from "../../server/worker/embed.ts";
import { runWorker } from "../../server/worker/run.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import type { EmbeddingProvider } from "../../server/embeddings/provider.ts";

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-mcp");

let t: TestApp;
let http: Server;
let pool: pg.Pool;
let urls: { url: string; readerUrl: string; proposerUrl: string; mcpRoles: boolean };
let owner: Session;
const fake = new FakeEmbeddingProvider();

interface TokenRow {
  id: number;
  name: string;
  tokenPrefix: string;
  workspaceScope: string[];
  revokedAt: string | null;
}
const tokens: Record<string, string> = {};
const tokenIds: Record<string, number> = {};

const csrf = () => ({ "x-csrf-token": owner.csrf });

async function mint(name: string, workspaceScope: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name, workspaceScope, ...extra });
  expect(res.status, res.text).toBe(201);
  tokens[name] = res.body.token;
  tokenIds[name] = res.body.item.id;
  return res.body.token as string;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

/** Calls a tool and parses the JSON text payload; `error` is set when the tool answered isError. */
async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T & { error?: string; message?: string }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The SDK rejects arguments that fail the input schema before the tool runs: "MCP error -32602: …".
    expect(r.isError, text).toBe(true);
    parsed = { error: "invalid_params", message: text };
  }
  if (r.isError) expect(parsed.error, text).toBeTruthy();
  return parsed as T & { error?: string; message?: string };
}

async function rowCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const out: Record<string, number> = {};
  for (const r of rows) {
    const c = await pool.query(`select count(*)::int as n from "${r.table_name}"`);
    out[r.table_name] = c.rows[0].n;
  }
  return out;
}

const b64url = (b: Buffer) => b.toString("base64url");
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  urls = await resetDatabase(server, "strout_vault_mcp", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  t = await buildTestApp(
    {
      DATABASE_URL: urls.url,
      LOCAL_STORAGE_DIR: STORAGE,
      PUBLIC_URL: BASE,
      MCP_READER_DATABASE_URL: urls.readerUrl,
      MCP_PROPOSER_DATABASE_URL: urls.proposerUrl,
      EMBEDDING_PROVIDER: "fake",
      LOGIN_RATE_LIMIT_MAX: "200",
    },
    { mcp: { embeddings: fake } },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
  // Embed every transcribed recording with the fake provider so semantic search has data.
  for (const c of await listEmbedCandidates(pool)) await embedInteraction(pool, fake, c.id);
  await mint("full", ["*", "phalanx"]);
  await mint("star", ["*"]);
  await mint("story", ["another_story"]);
  await mint("nothing", []);
}, 180_000);

afterAll(async () => {
  // Keep-alive sockets from the MCP clients would otherwise hold server.close() open for minutes.
  http?.closeAllConnections();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  await t?.close();
  await pool?.end();
});

// ------------------------------------------------------------------- auth --
describe("bearer auth", () => {
  it("rejects a missing, malformed, unknown, revoked or expired token with 401 and the discovery header", async () => {
    const post = (auth?: string) =>
      request(t.app)
        .post("/mcp")
        .set("accept", "application/json, text/event-stream")
        .set(auth ? { authorization: auth } : {})
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const missing = await post();
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect((await post("Basic abc")).status).toBe(401);
    expect((await post("Bearer svt_nope")).status).toBe(401);
    expect((await post("Bearer not-a-real-oauth-token")).status).toBe(401);

    const token = await mint("to-revoke", ["another_story"]);
    expect((await post(`Bearer ${token}`)).status).toBe(200);
    const rev = await owner.agent.post(`/api/mcp/tokens/${tokenIds["to-revoke"]}/revoke`).set(csrf());
    expect(rev.status).toBe(200);
    expect(rev.body.revokedAt).toBeTruthy();
    expect((await post(`Bearer ${token}`)).status).toBe(401);

    const expiring = await mint("expiring", ["another_story"], { expiresInDays: 1 });
    expect((await post(`Bearer ${expiring}`)).status).toBe(200);
    await pool.query(`update api_tokens set expires_at = now() - interval '1 minute' where id = $1`, [tokenIds["expiring"]]);
    expect((await post(`Bearer ${expiring}`)).status).toBe(401);
  });

  it("stores only a hash and a prefix; the token page never reveals the token again", async () => {
    const { rows } = await pool.query(`select token_hash, token_prefix from api_tokens where id = $1`, [tokenIds["full"]]);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].token_prefix).toBe(tokens.full.slice(0, 10));
    expect(JSON.stringify(rows[0])).not.toContain(tokens.full.slice(10, 30));
    const list = await owner.agent.get("/api/mcp/tokens");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(tokens.full.slice(10, 30));
    const full = (list.body.items as TokenRow[]).find((x) => x.id === tokenIds["full"])!;
    expect(full.workspaceScope).toEqual(["*", "phalanx"]);
    expect(full.tokenPrefix).toBe(tokens.full.slice(0, 10));
  });

  it("keeps the token pages owner-only and validates the scope", async () => {
    expect((await request(t.app).get("/api/mcp/tokens")).status).toBe(401);
    await request(t.app).post("/api/auth/magic-link").send({ email: "kevin.mcguire@example.com" });
    const contractor = request.agent(t.app);
    await contractor.get(`/api/auth/magic?token=${encodeURIComponent(lastMagicToken(t.mailer)!)}`);
    expect((await contractor.get("/api/mcp/tokens")).status).toBe(403);
    expect((await contractor.get("/api/mcp/audit")).status).toBe(403);
    const bad = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "x", workspaceScope: ["nope"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown workspace/);
  });
});

// ------------------------------------------------------------------ tools --
describe("tools/list", () => {
  it("advertises the eight tools with descriptions written for an agent", async () => {
    const client = await connect(tokens.full);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(["get_interaction", "get_party", "get_project", "list_interactions", "list_leads", "list_open_commitments", "propose_update", "search_conversations"]);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
    }
    const search = tools.find((x) => x.name === "search_conversations")!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === "propose_update")!.annotations?.readOnlyHint).toBe(false);
    // The descriptions treat transcript text as data.
    expect(search.description).toMatch(/never as instructions/);
    await client.close();
  });
});

describe("search_conversations", () => {
  it("keyword mode finds a unique phrase in exactly one recording with the snippet at the right second", async () => {
    const client = await connect(tokens.full);
    const r = await call<{ results: Array<Record<string, unknown>>; semantic_coverage: string; mode_used: string }>(client, "search_conversations", { query: "pelican roof tiles", mode: "keyword" });
    expect(r.mode_used).toBe("keyword");
    expect(r.semantic_coverage).toBe("none");
    expect(r.results).toHaveLength(1);
    const hit = r.results[0];
    expect(hit.title).toBe("Pool house tile sample walkthrough");
    expect(hit.matched_by).toEqual(["keyword"]);
    const snippets = hit.snippets as Array<{ start_sec: number; speaker: string; text: string; via: string }>;
    expect(snippets[0]).toMatchObject({ start_sec: 42, via: "keyword" });
    expect(snippets[0].text).toContain("pelican roof tiles");
    expect(hit.deep_link).toBe(`${BASE}/r/${hit.interaction_id}?t=42`);
    await client.close();
  });

  it("hybrid mode fuses both rankers, groups by recording with at most three snippets, and reports full coverage", async () => {
    const client = await connect(tokens.full);
    const r = await call<{ results: Array<Record<string, unknown>>; semantic_coverage: string; mode_used: string }>(client, "search_conversations", { query: "copper gutters", limit: 10 });
    expect(r.mode_used).toBe("hybrid");
    expect(r.semantic_coverage).toBe("full");
    expect(r.results.length).toBeGreaterThan(3);
    expect(r.results.length).toBeLessThanOrEqual(10);
    expect(new Set(r.results.map((x) => x.interaction_id)).size).toBe(r.results.length);
    for (const hit of r.results) {
      const snippets = hit.snippets as unknown[];
      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets.length).toBeLessThanOrEqual(3);
      expect((hit.matched_by as string[]).length).toBeGreaterThan(0);
    }
    expect(r.results.some((x) => (x.matched_by as string[]).includes("semantic"))).toBe(true);
    // Scores descend.
    const scores = r.results.map((x) => x.score as number);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    await client.close();
  });

  it("semantic mode finds the recording that holds a distinctive passage, and limits respect the 50 cap", async () => {
    const client = await connect(tokens.full);
    // "board observer seat" is said in exactly one seeded recording; the fake provider is a bag of
    // words, so the exact words rank it first and the wider paraphrase still keeps it in the top 3.
    const r = await call<{ results: Array<Record<string, unknown>>; mode_used: string }>(client, "search_conversations", { query: "board observer seat", mode: "semantic", limit: 3 });
    expect(r.mode_used).toBe("semantic");
    expect(r.results[0].title).toBe("Harbor Point seed terms");
    expect(r.results[0].matched_by).toEqual(["semantic"]);
    const wider = await call<{ results: Array<Record<string, unknown>> }>(client, "search_conversations", { query: "board observer seat pro rata pre-money", mode: "semantic", limit: 3 });
    expect(wider.results.map((x) => x.title)).toContain("Harbor Point seed terms");
    const big = await call<{ results: unknown[] }>(client, "search_conversations", { query: "the", limit: 500 });
    expect(big.results.length).toBeLessThanOrEqual(50);
    await client.close();
  });

  it("marks coverage partial when a recording in scope has no embeddings yet and falls back to keyword for it", async () => {
    const client = await connect(tokens.full);
    const target = await pool.query(`select id from interactions where title = 'Pool house tile sample walkthrough'`);
    await pool.query(`delete from chunks where interaction_id = $1`, [target.rows[0].id]);
    try {
      const r = await call<{ results: Array<Record<string, unknown>>; semantic_coverage: string; note: string }>(client, "search_conversations", { query: "pelican roof tiles" });
      expect(r.semantic_coverage).toBe("partial");
      expect(r.note).toMatch(/1 recording\(s\) in scope have no embeddings/);
      expect(r.results.some((x) => x.title === "Pool house tile sample walkthrough")).toBe(true);
    } finally {
      await embedInteraction(pool, fake, target.rows[0].id);
    }
    await client.close();
  });

  it("filters by workspace, party, project and date, and says so when the workspace is out of scope", async () => {
    const client = await connect(tokens.full);
    const ws = await call<{ results: Array<Record<string, unknown>> }>(client, "search_conversations", { query: "copper gutters", workspace: "southern_shutter", limit: 50 });
    expect(ws.results.length).toBeGreaterThan(0);
    expect(ws.results.every((x) => x.workspace_id === "southern_shutter")).toBe(true);
    const party = await call<{ results: Array<Record<string, unknown>> }>(client, "search_conversations", { query: "copper gutters", party_id: 4, limit: 50 });
    for (const hit of party.results) {
      const { rowCount } = await pool.query(`select 1 from interaction_participants where interaction_id = $1 and party_id = 4`, [hit.interaction_id]);
      expect(rowCount).toBe(1);
    }
    const dated = await call<{ results: Array<Record<string, unknown>> }>(client, "search_conversations", { query: "copper gutters", since: "2026-01-01", until: "2026-12-31", limit: 50 });
    expect(dated.results.every((x) => String(x.occurred_at).startsWith("2026"))).toBe(true);
    const story = await connect(tokens.story);
    const out = await call<{ results: unknown[]; note: string }>(story, "search_conversations", { query: "copper gutters", workspace: "phalanx" });
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/not within this token's scope/);
    await client.close();
    await story.close();
  });
});

describe("get_interaction", () => {
  it("returns metadata, participants, projects and a ±90 s excerpt by default, never the whole transcript", async () => {
    const client = await connect(tokens.full);
    const longest = await pool.query(`select i.id, count(s.*)::int as n, max(s.end_sec) as last from interactions i join segments s on s.interaction_id = i.id group by i.id order by n desc limit 1`);
    const id = longest.rows[0].id as number;
    const r = await call<Record<string, any>>(client, "get_interaction", { id });
    expect(r.id).toBe(id);
    expect(r.participants.length).toBeGreaterThan(0);
    expect(r.participants[0]).toHaveProperty("party_id");
    expect(r.transcript.segments).toBe(longest.rows[0].n);
    expect(r.transcript.excerpt).toMatchObject({ from_sec: 0, to_sec: 180 });
    expect(r.transcript.excerpt.lines.length).toBeGreaterThan(0);
    expect(r.transcript.excerpt.lines.length).toBeLessThan(r.transcript.segments);
    for (const line of r.transcript.excerpt.lines) expect(line.start_sec).toBeLessThan(180);
    expect(r.transcript.excerpt.next_start_sec).toBeGreaterThan(180);
    expect(r.deep_link).toBe(`${BASE}/r/${id}?t=0`);
    await client.close();
  });

  it("pages through a long recording with next_start_sec until every segment has been seen", async () => {
    const client = await connect(tokens.full);
    const longest = await pool.query(`select i.id, count(s.*)::int as n from interactions i join segments s on s.interaction_id = i.id group by i.id order by n desc limit 1`);
    const id = longest.rows[0].id as number;
    const seen = new Set<number>();
    let start: number | undefined;
    let pages = 0;
    for (;;) {
      const r = await call<Record<string, any>>(client, "get_interaction", { id, start_sec: start, window_sec: 600 });
      pages++;
      for (const line of r.transcript.excerpt.lines) seen.add(line.start_sec);
      expect(r.transcript.excerpt.to_sec - r.transcript.excerpt.from_sec).toBeLessThanOrEqual(600);
      if (r.transcript.excerpt.next_start_sec == null) break;
      start = r.transcript.excerpt.next_start_sec;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
    const all = await pool.query(`select start_sec from segments where interaction_id = $1`, [id]);
    for (const s of all.rows) expect(seen.has(Number(s.start_sec))).toBe(true);
    // The window is clamped to 10 minutes.
    const wide = await call<Record<string, any>>(client, "get_interaction", { id, start_sec: 900, window_sec: 5000 });
    expect(wide.error).toBeTruthy(); // zod rejects > 600
    await client.close();
  });

  it("answers not_found for an unknown id and for a recording outside the scope", async () => {
    const client = await connect(tokens.story);
    expect((await call(client, "get_interaction", { id: 999999 })).error).toBe("not_found");
    const phalanx = await pool.query(`select id from interactions where workspace_id = 'phalanx' limit 1`);
    expect((await call(client, "get_interaction", { id: phalanx.rows[0].id })).error).toBe("not_found");
    await client.close();
  });
});

describe("list_interactions", () => {
  it("lists newest first with participants and filters by workspace, kind and dates", async () => {
    const client = await connect(tokens.full);
    const all = await call<{ items: Array<Record<string, any>> }>(client, "list_interactions", { limit: 50 });
    expect(all.items.length).toBeGreaterThan(10);
    const dates = all.items.map((x) => x.occurred_at as string);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(all.items[0]).toHaveProperty("deep_link", `${BASE}/r/${all.items[0].interaction_id}`);
    const calls = await call<{ items: Array<Record<string, any>> }>(client, "list_interactions", { kind: "call", workspace: "another_story", since: "2024-01-01" });
    expect(calls.items.length).toBeGreaterThan(0);
    expect(calls.items.every((x) => x.kind === "call" && x.workspace_id === "another_story" && x.occurred_at >= "2024-01-01")).toBe(true);
    const dflt = await call<{ items: unknown[] }>(client, "list_interactions", {});
    expect(dflt.items.length).toBeLessThanOrEqual(20);
    await client.close();
  });
});

describe("get_party", () => {
  it("resolves by id, exact name, email and phone; a vague name returns candidates", async () => {
    const client = await connect(tokens.full);
    const byId = await call<Record<string, any>>(client, "get_party", { id: 2 });
    expect(byId.name).toBe("Kevin McGuire");
    expect(byId.roles[0]).toMatchObject({ workspace_id: "another_story", role: "contractor" });
    expect(byId.recent_interactions.length).toBeGreaterThan(0);
    expect(byId.recent_interactions.length).toBeLessThanOrEqual(10);
    expect(byId.relationships.some((r: Record<string, unknown>) => r.name === "Ben Strout")).toBe(true);
    expect(byId.deep_link).toBe(`${BASE}/p/2`);
    expect((await call<Record<string, any>>(client, "get_party", { name: "kevin mcguire" })).party_id).toBe(2);
    expect((await call<Record<string, any>>(client, "get_party", { name: "McGuire" })).party_id).toBe(2);
    expect((await call<Record<string, any>>(client, "get_party", { email: "Lena@gulfcoastmillwork.example.com" })).party_id).toBe(7);
    expect((await call<Record<string, any>>(client, "get_party", { phone: "(713) 555-0187" })).party_id).toBe(3);
    const vague = await call<Record<string, any>>(client, "get_party", { name: "ben" });
    expect(vague.ambiguous).toBe(true);
    expect(vague.candidates.map((c: Record<string, unknown>) => c.name)).toContain("Ben Strout");
    expect((await call(client, "get_party", { name: "zzzz nobody" })).error).toBe("not_found");
    expect((await call(client, "get_party", {})).error).toBe("invalid_argument");
    const org = await call<Record<string, any>>(client, "get_party", { name: "Gulf Coast Millwork" });
    expect(org.kind).toBe("org");
    expect(org.affiliations.some((a: Record<string, unknown>) => a.name === "Lena Fischer")).toBe(true);
    await client.close();
  });

  it("includes facts about or owned by the party", async () => {
    const client = await connect(tokens.full);
    const withFacts = await pool.query(`select owner_party_id as id from facts where owner_party_id is not null group by 1 order by count(*) desc limit 1`);
    const p = await call<Record<string, any>>(client, "get_party", { id: withFacts.rows[0].id });
    expect(p.facts.length).toBeGreaterThan(0);
    expect(p.facts[0]).toHaveProperty("role");
    expect(p.facts[0].interaction).toHaveProperty("deep_link");
    await client.close();
  });
});

describe("get_project", () => {
  it("resolves by id and fuzzy name with parties, interactions and facts; several matches return candidates", async () => {
    const client = await connect(tokens.full);
    const p = await call<Record<string, any>>(client, "get_project", { name: "bungalow" });
    expect(p.name).toBe("Heights Bungalow Addition");
    expect(p.parties.map((x: Record<string, unknown>) => x.role)).toContain("client");
    expect(p.interactions.length).toBeGreaterThan(0);
    expect(p.deep_link).toBe(`${BASE}/projects/${p.project_id}`);
    expect((await call<Record<string, any>>(client, "get_project", { id: p.project_id })).name).toBe(p.name);
    const vague = await call<Record<string, any>>(client, "get_project", { name: "a" });
    expect(vague.ambiguous).toBe(true);
    expect(vague.candidates.length).toBeGreaterThan(1);
    expect((await call(client, "get_project", { name: "nonexistent project xyz" })).error).toBe("not_found");
    await client.close();
  });
});

describe("list_open_commitments", () => {
  it("returns open commitments with their source moment, honours filters, and is empty when nothing matches", async () => {
    const client = await connect(tokens.full);
    const r = await call<{ items: Array<Record<string, any>>; count: number }>(client, "list_open_commitments", { limit: 50 });
    expect(r.count).toBeGreaterThan(0);
    for (const f of r.items) {
      expect(["commitment", "task", "follow_up", "followup"]).toContain(f.kind);
      expect(f.status).toBe("open");
      expect(f.source).toHaveProperty("quote_start_sec");
      expect(f.deep_link).toMatch(new RegExp(`^${BASE}/r/\\d+\\?t=\\d+$`));
    }
    const due = await call<{ items: Array<Record<string, any>> }>(client, "list_open_commitments", { due_before: "2024-01-01" });
    expect(due.items.every((f) => f.due_date <= "2024-01-01")).toBe(true);
    const party = await call<{ items: Array<Record<string, any>> }>(client, "list_open_commitments", { party_id: 3 });
    expect(party.items.every((f) => f.owner?.party_id === 3 || f.about?.party_id === 3)).toBe(true);
    const none = await call<{ items: unknown[]; count: number }>(client, "list_open_commitments", { due_before: "2000-01-01" });
    expect(none).toMatchObject({ count: 0, items: [] });
    await client.close();
  });

  it("returns an empty list cleanly while the facts table is empty", async () => {
    const client = await connect(tokens.full);
    const backup = await pool.query(`select * from facts`);
    await pool.query(`delete from facts`);
    try {
      expect(await call(client, "list_open_commitments", {})).toMatchObject({ count: 0, items: [] });
    } finally {
      for (const f of backup.rows) {
        await pool.query(
          `insert into facts (id, interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, project_id, amount, due_date, status, confidence, quote_start_sec, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [f.id, f.interaction_id, f.workspace_id, f.kind, f.text, f.owner_party_id, f.about_party_id, f.project_id, f.amount, f.due_date, f.status, f.confidence, f.quote_start_sec, f.created_at],
        );
      }
    }
    await client.close();
  });
});

// ------------------------------------------------------------------ scope --
describe("workspace scope", () => {
  const PHALANX_WORDS = "cap the pilot at one site ninety days security committee budget cycle";

  it("a token scoped to another_story gets zero phalanx results from every tool and every search mode", async () => {
    const story = await connect(tokens.story);
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const r = await call<{ results: Array<Record<string, unknown>> }>(story, "search_conversations", { query: PHALANX_WORDS, mode, limit: 50 });
      expect(r.results.filter((x) => x.workspace_id === "phalanx"), mode).toEqual([]);
      expect(r.results.every((x) => x.workspace_id === "another_story"), mode).toBe(true);
      const broad = await call<{ results: Array<Record<string, unknown>> }>(story, "search_conversations", { query: "the", mode, limit: 50 });
      expect(broad.results.every((x) => x.workspace_id === "another_story"), mode).toBe(true);
    }
    const list = await call<{ items: Array<Record<string, unknown>> }>(story, "list_interactions", { limit: 50 });
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((x) => x.workspace_id === "another_story")).toBe(true);
    // People who exist only in phalanx are invisible, by name, by fuzzy name, by email and by id.
    expect((await call(story, "get_party", { name: "Daniel Okafor" })).error).toBe("not_found");
    expect((await call(story, "get_party", { name: "okaf" })).error).toBe("not_found");
    expect((await call(story, "get_party", { email: "daniel.okafor@example.com" })).error).toBe("not_found");
    expect((await call(story, "get_party", { id: 6 })).error).toBe("not_found");
    // Priya (credvault investor, phalanx advisor) is outside too. Ben is in every workspace, but only
    // his another_story roles, projects and recordings show.
    expect((await call(story, "get_party", { name: "Priya" })).error).toBe("not_found");
    const ben = await call<Record<string, any>>(story, "get_party", { id: 1 });
    expect(ben.roles.map((r: Record<string, unknown>) => r.workspace_id)).toEqual(["another_story"]);
    expect(ben.projects.every((p: Record<string, unknown>) => p.workspace_id === "another_story")).toBe(true);
    expect(ben.recent_interactions.length).toBeGreaterThan(0);
    expect(ben.recent_interactions.every((i: Record<string, unknown>) => i.workspace_id === "another_story")).toBe(true);
    // A credvault token sees Rachel's credvault side only; a sepp token sees her sepp side only.
    const credTok = await mint("cred", ["credvault"]);
    const cred = await connect(credTok);
    const rachel = await call<Record<string, any>>(cred, "get_party", { name: "Rachel Kim" });
    expect(rachel.roles.map((r: Record<string, unknown>) => r.workspace_id)).toEqual(["credvault"]);
    expect(rachel.recent_interactions.every((i: Record<string, unknown>) => i.workspace_id === "credvault")).toBe(true);
    await cred.close();
    expect((await call(story, "get_project", { name: "Phalanx Pilot" })).error).toBe("not_found");
    expect((await call(story, "get_project", { id: 5 })).error).toBe("not_found");
    const commitments = await call<{ items: Array<Record<string, unknown>> }>(story, "list_open_commitments", { limit: 50 });
    expect(commitments.items.every((f) => f.workspace_id === "another_story")).toBe(true);
    const phalanxRec = await pool.query(`select id from interactions where workspace_id = 'phalanx' and exists (select 1 from segments s where s.interaction_id = interactions.id) limit 1`);
    expect((await call(story, "propose_update", { item_type: "new_fact", proposal: { interaction_id: phalanxRec.rows[0].id, kind: "decision", text: "x" }, reason: "r" })).error).toBe("not_found");
    expect((await call(story, "propose_update", { item_type: "new_party", proposal: { kind: "person", name: "X", role: { workspace_id: "phalanx", role: "prospect" } }, reason: "r" })).error).toBe("out_of_scope");
    await story.close();

    // The same phalanx phrase is found by a token that includes phalanx, in every mode (the fake
    // provider is a bag of words, so in semantic mode other phalanx recordings that share the
    // words can rank close; the expected recording is in the top 3 and nothing outside phalanx is).
    const full = await connect(tokens.full);
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const r = await call<{ results: Array<Record<string, unknown>> }>(full, "search_conversations", { query: PHALANX_WORDS, mode, limit: 5 });
      expect(r.results.slice(0, 3).map((x) => x.title), mode).toContain("Phalanx pilot scope with Daniel");
      if (mode === "keyword") expect(r.results[0]?.title).toBe("Phalanx pilot scope with Daniel");
    }
    expect((await call<Record<string, any>>(full, "get_party", { name: "Daniel Okafor" })).party_id).toBe(6);
    await full.close();
  });

  it("'*' never includes phalanx unless it is listed explicitly, and an empty scope sees nothing", async () => {
    const star = await connect(tokens.star);
    const list = await call<{ items: Array<Record<string, unknown>> }>(star, "list_interactions", { limit: 50 });
    expect(list.items.length).toBeGreaterThan(10);
    expect(list.items.some((x) => x.workspace_id === "phalanx")).toBe(false);
    expect(new Set(list.items.map((x) => x.workspace_id)).size).toBeGreaterThan(3);
    expect((await call(star, "get_project", { id: 5 })).error).toBe("not_found");
    const search = await call<{ results: Array<Record<string, unknown>> }>(star, "search_conversations", { query: PHALANX_WORDS, mode: "semantic", limit: 50 });
    expect(search.results.some((x) => x.workspace_id === "phalanx")).toBe(false);
    await star.close();

    const full = await connect(tokens.full);
    const all = await call<{ items: Array<Record<string, unknown>> }>(full, "list_interactions", { workspace: "phalanx", limit: 50 });
    expect(all.items.length).toBeGreaterThan(0);
    expect(all.items.every((x) => x.workspace_id === "phalanx")).toBe(true);
    await full.close();

    const nothing = await connect(tokens.nothing);
    expect(await call(nothing, "list_interactions", {})).toMatchObject({ count: 0, items: [] });
    expect((await call<{ results: unknown[] }>(nothing, "search_conversations", { query: "copper gutters" })).results).toEqual([]);
    expect((await call(nothing, "get_party", { id: 1 })).error).toBe("not_found");
    expect(await call(nothing, "list_open_commitments", {})).toMatchObject({ count: 0 });
    await nothing.close();
  });
});

// ------------------------------------------------------------ propose_update --
describe("propose_update", () => {
  it("queues a valid proposal in review_queue (open, tagged as coming from the agent) and changes nothing else", async () => {
    const client = await connect(tokens.full);
    const before = await rowCounts();
    const rec = await pool.query(`select id from interactions where workspace_id = 'strout_arch' and exists (select 1 from segments s where s.interaction_id = interactions.id) order by id limit 1`);
    const r = await call<Record<string, any>>(client, "propose_update", {
      item_type: "new_fact",
      proposal: { interaction_id: rec.rows[0].id, kind: "commitment", text: "Carlos will send the revised framing quote by Friday.", owner_party_id: 13, due_date: "2026-11-07", quote_start_sec: 125 },
      reason: "Carlos says so at 2:05.",
    });
    expect(r).toMatchObject({ queued: true, item_type: "new_fact", status: "open", interaction_id: rec.rows[0].id, deep_link: `${BASE}/review` });
    const after = await rowCounts();
    for (const table of Object.keys(before)) {
      const expected = table === "review_queue" ? before[table] + 1 : table === "mcp_audit" ? after[table] : before[table];
      expect(after[table], table).toBe(expected);
    }
    expect(after.mcp_audit).toBeGreaterThan(before.mcp_audit);
    const row = await pool.query(`select * from review_queue where id = $1`, [r.review_id]);
    expect(row.rows[0]).toMatchObject({ item_type: "new_fact", status: "open", interaction_id: rec.rows[0].id, reason: "Carlos says so at 2:05." });
    expect(row.rows[0].proposal).toMatchObject({ kind: "commitment", source: "mcp", proposed_by: "full", token_id: `pat:${tokenIds.full}`, owner_party_id: 13 });
    // The owner sees it in the Review queue.
    const review = await owner.agent.get("/api/review?status=open");
    expect(review.body.items.some((it: { id: number }) => it.id === r.review_id)).toBe(true);

    const link = await call<Record<string, any>>(client, "propose_update", { item_type: "link_party_interaction", proposal: { party_id: 13, interaction_id: rec.rows[0].id, speaker_label: "Speaker 2", confidence: 0.8 }, reason: "voice match", interaction_id: rec.rows[0].id });
    expect(link.queued).toBe(true);
    const party = await call<Record<string, any>>(client, "propose_update", { item_type: "new_party", proposal: { kind: "org", name: "Lone Star Lumber", website: "https://lonestar.example.com", role: { workspace_id: "southern_shutter", role: "vendor" } }, reason: "mentioned as the backup mill" });
    expect(party.queued).toBe(true);
    await client.close();
  });

  it("rejects invalid proposals with the validation issues and writes nothing", async () => {
    const client = await connect(tokens.full);
    const before = await rowCounts();
    const bad = await call<Record<string, any>>(client, "propose_update", { item_type: "new_fact", proposal: { kind: "wish", text: 42 }, reason: "r" });
    expect(bad.error).toBe("invalid_proposal");
    expect(bad.issues.map((i: { path: string }) => i.path).sort()).toEqual(["interaction_id", "kind", "text"]);
    expect((await call(client, "propose_update", { item_type: "party_edit", proposal: { party_id: 2, changes: {} }, reason: "r" })).error).toBe("invalid_proposal");
    expect((await call(client, "propose_update", { item_type: "party_edit", proposal: { party_id: 2, changes: { name: "K" }, extra: true }, reason: "r" })).error).toBe("invalid_proposal");
    expect((await call(client, "propose_update", { item_type: "new_relationship", proposal: { from_party_id: 2, to_party_id: 2, kind: "knows" }, reason: "r" })).error).toBe("invalid_proposal");
    expect((await call(client, "propose_update", { item_type: "new_relationship", proposal: { from_party_id: 2, to_party_id: 999999, kind: "knows" }, reason: "r" })).error).toBe("not_found");
    expect((await call(client, "propose_update", { item_type: "link_project_interaction", proposal: { project_id: 1, interaction_id: 999999 }, reason: "r" })).error).toBe("not_found");
    expect((await call(client, "propose_update", { item_type: "bogus", proposal: {}, reason: "r" })).error).toBeTruthy();
    const after = await rowCounts();
    for (const table of Object.keys(before)) if (table !== "mcp_audit") expect(after[table], table).toBe(before[table]);
    await client.close();
  });

  it("the proposer role really can only insert into review_queue", async () => {
    if (!urls.mcpRoles) return; // roles could not be created on this server; the SQL grants are still in the migration
    const proposer = new pg.Pool({ connectionString: urls.proposerUrl, max: 1 });
    const reader = new pg.Pool({ connectionString: urls.readerUrl, max: 1 });
    try {
      await expect(proposer.query(`select count(*) from interactions`)).rejects.toThrow(/permission denied/);
      await expect(proposer.query(`update review_queue set status = 'approved' where false`)).rejects.toThrow(/permission denied/);
      await expect(proposer.query(`delete from review_queue where false`)).rejects.toThrow(/permission denied/);
      await expect(proposer.query(`insert into facts (kind, text) values ('other', 'x')`)).rejects.toThrow(/permission denied/);
      await expect(reader.query(`insert into review_queue (item_type, proposal) values ('x', '{}')`)).rejects.toThrow(/permission denied/);
      await expect(reader.query(`update interactions set title = title where false`)).rejects.toThrow(/permission denied/);
      await expect(reader.query(`select count(*) from api_tokens`)).rejects.toThrow(/permission denied/);
      expect((await reader.query(`select count(*)::int as n from chunks`)).rows[0].n).toBeGreaterThan(0);
    } finally {
      await proposer.end();
      await reader.end();
    }
  });
});

// ------------------------------------------------------- audit + rate limit --
describe("audit log and rate limit", () => {
  it("logs every call with the token, tool, redacted args, scope, result count and duration", async () => {
    const client = await connect(tokens.story);
    const longQuery = "copper ".repeat(60); // 420 chars: under the schema's 500, over the audit's 300
    await call(client, "search_conversations", { query: longQuery, limit: 2 });
    await call(client, "get_interaction", { id: 999999 });
    const { rows } = await pool.query(`select * from mcp_audit where token_id = $1 order by id desc limit 2`, [`pat:${tokenIds.story}`]);
    expect(rows[1]).toMatchObject({ client_name: "story", tool: "search_conversations", workspace_scope: ["another_story"], error: null });
    expect(rows[1].result_count).toBeGreaterThanOrEqual(0);
    expect(rows[1].duration_ms).toBeGreaterThanOrEqual(0);
    expect(String(rows[1].args.query)).toMatch(/… \(420 chars\)$/);
    expect(rows[0]).toMatchObject({ tool: "get_interaction", result_count: null });
    expect(rows[0].error).toMatch(/^not_found/);
    const page = await owner.agent.get(`/api/mcp/audit?token=pat:${tokenIds.story}&tool=get_interaction`);
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeGreaterThan(0);
    expect(page.body.items.every((r: { tokenId: string; tool: string }) => r.tokenId === `pat:${tokenIds.story}` && r.tool === "get_interaction")).toBe(true);
    const status = await owner.agent.get("/api/mcp/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, oauthEnabled: true, endpoint: `${BASE}/mcp`, rateLimitPerMin: 60, rolesConfigured: { reader: urls.mcpRoles, proposer: urls.mcpRoles } });
    expect(status.body.embeddings.embedded).toBeGreaterThan(30);
    expect(status.body.tools).toHaveLength(8);
    await client.close();
  });

  it("refuses the 61st call in a minute for one token, without affecting other tokens", async () => {
    const limited = await mint("limited", ["another_story"]);
    const client = await connect(limited);
    let refused: Record<string, unknown> | null = null;
    for (let i = 0; i < 61; i++) {
      const r = await call(client, "list_interactions", { limit: 1 });
      if (r.error) {
        refused = r;
        expect(i).toBe(60);
        break;
      }
    }
    expect(refused).toMatchObject({ error: "rate_limited", retry_after_sec: expect.any(Number) });
    const other = await connect(tokens.story);
    expect((await call(other, "list_interactions", { limit: 1 })).error).toBeUndefined();
    const audit = await pool.query(`select count(*)::int as n from mcp_audit where token_id = $1 and error = 'rate_limited'`, [`pat:${tokenIds.limited}`]);
    expect(audit.rows[0].n).toBe(1);
    await client.close();
    await other.close();
  }, 60_000);
});

// ------------------------------------------------------------------ OAuth --
describe("OAuth 2.1 for Claude.ai connectors", () => {
  const REDIRECT = "http://localhost:9977/callback";

  it("publishes authorization-server and protected-resource metadata", async () => {
    const as = await request(t.app).get("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({ issuer: `${BASE}/`, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ["S256"] });
    expect(as.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    const prm = await request(t.app).get("/.well-known/oauth-protected-resource/mcp");
    expect(prm.status).toBe(200);
    expect(prm.body).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`] });
  });

  it("runs the whole flow: dynamic registration, PKCE, login + consent with workspace choice, code exchange, scoped tool calls, refresh rotation, replay detection and revocation", async () => {
    // 1. Dynamic client registration (public client, as Claude.ai does).
    const reg = await request(t.app).post("/register").send({ client_name: "Claude (test)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    expect(reg.status, reg.text).toBe(201);
    const clientId = reg.body.client_id as string;
    expect(reg.body.client_secret).toBeUndefined();

    // 2. /authorize validates and sends the browser to the consent page.
    const { verifier, challenge } = pkce();
    const authz = await request(t.app).get("/authorize").query({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "vault:read vault:propose", resource: `${BASE}/mcp` });
    expect(authz.status).toBe(302);
    const consentUrl = new URL(authz.headers.location, BASE);
    expect(consentUrl.pathname).toBe("/oauth/consent");
    const req = consentUrl.searchParams.get("req")!;
    expect(req).toBeTruthy();

    // 3. Not signed in: the consent page shows the app's email + password login.
    const browser = request.agent(t.app);
    const anon = await browser.get(`/oauth/consent?req=${encodeURIComponent(req)}`);
    expect(anon.status).toBe(200);
    expect(anon.text).toContain('action="/oauth/consent/login"');
    expect(anon.text).toContain("Claude (test)");
    const wrong = await browser.post("/oauth/consent/login").type("form").send({ req, email: ADMIN_EMAIL, password: "nope" });
    expect(wrong.status).toBe(401);
    const loginRes = await browser.post("/oauth/consent/login").type("form").send({ req, email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(loginRes.status).toBe(303);
    expect(loginRes.headers["set-cookie"]?.[0]).toMatch(/^sv_session=/);

    // 4. Signed in: the consent form lists workspaces with phalanx unticked.
    const consent = await browser.get(`/oauth/consent?req=${encodeURIComponent(req)}`);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('action="/oauth/consent/decide"');
    expect(consent.text).toMatch(/value="another_story" checked/);
    expect(consent.text).toMatch(/value="phalanx">/); // no "checked"
    const csrfToken = /name="csrf" value="([^"]+)"/.exec(consent.text)![1];

    // A denial goes back with error=access_denied.
    const denied = await browser.post("/oauth/consent/decide").type("form").send({ req, csrf: csrfToken, decision: "deny" });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.location).searchParams.get("error")).toBe("access_denied");
    // A wrong CSRF token is refused.
    expect((await browser.post("/oauth/consent/decide").type("form").send({ req, csrf: "nope", decision: "approve", workspace: ["another_story"] })).status).toBe(403);

    // 5. Approve two workspaces: the browser lands on the redirect_uri with code + state.
    const approved = await browser.post("/oauth/consent/decide").type("form").send({ req, csrf: csrfToken, decision: "approve", workspace: ["another_story", "strout_arch"] });
    expect(approved.status, approved.text).toBe(302);
    const back = new URL(approved.headers.location);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);
    const stored = await pool.query(`select code_hash, used_at from oauth_codes order by created_at desc limit 1`);
    expect(stored.rows[0].code_hash).not.toBe(code);
    expect(stored.rows[0].code_hash).toBe(crypto.createHash("sha256").update(code).digest("hex"));

    // 6. Token exchange needs the right PKCE verifier.
    const badVerifier = await request(t.app).post("/token").type("form").send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", redirect_uri: REDIRECT });
    expect(badVerifier.status).toBe(400);
    expect(badVerifier.body.error).toBe("invalid_grant");
    const tok = await request(t.app).post("/token").type("form").send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${BASE}/mcp` });
    expect(tok.status, tok.text).toBe(200);
    expect(tok.body).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "vault:read vault:propose" });
    expect(tok.body.access_token).toBeTruthy();
    expect(tok.body.refresh_token).toBeTruthy();
    // The code is single-use.
    expect((await request(t.app).post("/token").type("form").send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })).status).toBe(400);
    // Tokens are stored hashed, with the consented scope.
    const trows = await pool.query(`select kind, token_hash, workspace_scope, user_email from oauth_tokens where client_id = $1 and revoked_at is null order by id`, [clientId]);
    expect(trows.rows.map((r) => r.kind)).toEqual(["access", "refresh"]);
    expect(trows.rows[0].token_hash).toBe(crypto.createHash("sha256").update(tok.body.access_token).digest("hex"));
    expect(trows.rows[0].workspace_scope).toEqual(["another_story", "strout_arch"]);
    expect(trows.rows[0].user_email).toBe(ADMIN_EMAIL);

    // 7. The access token works on /mcp with exactly the consented scope.
    const client = await connect(tok.body.access_token);
    const list = await call<{ items: Array<Record<string, unknown>> }>(client, "list_interactions", { limit: 50 });
    expect(new Set(list.items.map((x) => x.workspace_id))).toEqual(new Set(["another_story", "strout_arch"]));
    expect((await call(client, "get_project", { id: 5 })).error).toBe("not_found");
    const auditRow = await pool.query(`select token_id, client_name from mcp_audit order by id desc limit 1`);
    expect(auditRow.rows[0]).toMatchObject({ client_name: "Claude (test)" });
    expect(auditRow.rows[0].token_id).toMatch(/^oauth:\d+$/);
    await client.close();

    // 8. Refresh rotates: new pair, old refresh token dead, replay revokes the grant.
    const refreshed = await request(t.app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, refresh_token: tok.body.refresh_token });
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(refreshed.body.access_token).not.toBe(tok.body.access_token);
    expect(refreshed.body.refresh_token).not.toBe(tok.body.refresh_token);
    const client2 = await connect(refreshed.body.access_token);
    expect((await call<{ items: unknown[] }>(client2, "list_interactions", { limit: 1 })).items).toHaveLength(1);
    await client2.close();
    const replay = await request(t.app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, refresh_token: tok.body.refresh_token });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    // The replay killed the whole grant: the freshly issued tokens no longer work either.
    const dead = await request(t.app).post("/mcp").set("accept", "application/json, text/event-stream").set("authorization", `Bearer ${refreshed.body.access_token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(dead.status).toBe(401);
    expect((await request(t.app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshed.body.refresh_token })).status).toBe(400);

    // 9. Expired access tokens are refused.
    const again = await request(t.app).get("/authorize").query({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const req2 = new URL(again.headers.location, BASE).searchParams.get("req")!;
    const consent2 = await browser.get(`/oauth/consent?req=${encodeURIComponent(req2)}`);
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(consent2.text)![1];
    const approved2 = await browser.post("/oauth/consent/decide").type("form").send({ req: req2, csrf: csrf2, decision: "approve", workspace: ["sepp"] });
    const code2 = new URL(approved2.headers.location).searchParams.get("code")!;
    const tok2 = await request(t.app).post("/token").type("form").send({ grant_type: "authorization_code", client_id: clientId, code: code2, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(tok2.status).toBe(200);
    await pool.query(`update oauth_tokens set expires_at = now() - interval '1 second' where token_hash = $1`, [crypto.createHash("sha256").update(tok2.body.access_token).digest("hex")]);
    const expired = await request(t.app).post("/mcp").set("accept", "application/json, text/event-stream").set("authorization", `Bearer ${tok2.body.access_token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(expired.status).toBe(401);
    expect(expired.headers["www-authenticate"]).toMatch(/expired/);

    // 10. The connected-apps page lists the client with its last consented scope; revoking kills every token.
    const apps = await owner.agent.get("/api/mcp/clients");
    const app = apps.body.items.find((c: { clientId: string }) => c.clientId === clientId);
    expect(app).toMatchObject({ clientName: "Claude (test)", workspaceScope: ["sepp"], consentedBy: ADMIN_EMAIL });
    expect(app.activeGrants).toBe(1);
    const fresh = await request(t.app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, refresh_token: tok2.body.refresh_token });
    expect(fresh.status).toBe(200);
    const revoke = await owner.agent.post(`/api/mcp/clients/${clientId}/revoke`).set(csrf());
    expect(revoke.status).toBe(200);
    expect(revoke.body.revokedAt).toBeTruthy();
    const afterRevoke = await request(t.app).post("/mcp").set("accept", "application/json, text/event-stream").set("authorization", `Bearer ${fresh.body.access_token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(afterRevoke.status).toBe(401);
    expect((await request(t.app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, refresh_token: fresh.body.refresh_token })).status).toBe(400);
    // A revoked client cannot even start a new authorization.
    expect((await request(t.app).get("/authorize").query({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })).status).toBe(400);
  }, 60_000);

  it("refuses an unregistered redirect_uri and a tampered consent request", async () => {
    const reg = await request(t.app).post("/register").send({ client_name: "Other", redirect_uris: ["http://localhost:9978/cb"], token_endpoint_auth_method: "none" });
    const { challenge } = pkce();
    const bad = await request(t.app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: "http://evil.example.com/cb", code_challenge: challenge, code_challenge_method: "S256" });
    expect(bad.status).toBe(400);
    const ok = await request(t.app).get("/authorize").query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: "http://localhost:9978/cb", code_challenge: challenge, code_challenge_method: "S256" });
    const req = new URL(ok.headers.location, BASE).searchParams.get("req")!;
    const tampered = await owner.agent.get(`/oauth/consent?req=${encodeURIComponent(req.slice(0, -2) + "zz")}`);
    expect(tampered.status).toBe(400);
    expect((await owner.agent.get("/oauth/consent")).status).toBe(400);
  });
});

// ------------------------------------------------------- embedding pipeline --
describe("embedding pipeline", () => {
  it("re-running the chunker on a recording deletes and rebuilds its chunks inside one transaction", async () => {
    const rec = await pool.query(`select interaction_id, count(*)::int as n from chunks group by 1 order by n desc limit 1`);
    const id = rec.rows[0].interaction_id as number;
    const before = await pool.query(`select id, seq, start_sec, end_sec, text from chunks where interaction_id = $1 order by seq`, [id]);
    const total = (await pool.query(`select count(*)::int as n from chunks`)).rows[0].n;
    const plan = await planInteraction(pool, id);
    expect(plan.chunks.length).toBe(before.rows.length);
    const out = await embedInteraction(pool, fake, id);
    expect(out.chunks.length).toBe(before.rows.length);
    const after = await pool.query(`select id, seq, start_sec, end_sec, text from chunks where interaction_id = $1 order by seq`, [id]);
    expect(after.rows.map((r) => ({ seq: r.seq, start_sec: r.start_sec, end_sec: r.end_sec, text: r.text }))).toEqual(before.rows.map((r) => ({ seq: r.seq, start_sec: r.start_sec, end_sec: r.end_sec, text: r.text })));
    expect(after.rows.every((r, i) => r.id !== before.rows[i].id)).toBe(true); // fresh rows, same content
    expect((await pool.query(`select count(*)::int as n from chunks`)).rows[0].n).toBe(total);
    const segs = await pool.query(`select min(start_sec) as first, max(end_sec) as last from segments where interaction_id = $1`, [id]);
    expect(after.rows[0].start_sec).toBe(Math.floor(Number(segs.rows[0].first)));
    expect(after.rows[after.rows.length - 1].end_sec).toBe(Math.ceil(Number(segs.rows[0].last)));
  });

  it("the worker's embed step embeds pending recordings, records failures without touching pipeline_status, and is resumable", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: urls.url,
      SESSION_SECRET: "test-secret-test-secret-test-secret",
      ADMIN_EMAIL: "owner@test.local",
      ADMIN_PASSWORD_HASH: "$2b$12$n.14Mj6k0QzvENVWdt4cSuCT51Njj30l5Hsv60FoeGYekXVMpWypO",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: STORAGE,
      EMBEDDING_PROVIDER: "fake",
      EMBED_MAX_PER_RUN: "2",
    });
    const ctx: WorkerContext = {
      config,
      pool,
      storage: new LocalStorageDriver({ rootDir: STORAGE, secret: config.SESSION_SECRET }),
      fetchImpl: fetch,
      sleep: async () => {},
      now: () => new Date(),
      log: () => {},
      tmpDir: path.join(STORAGE, "tmp"),
      tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      deadline: Date.now() + 60_000,
      bytesBudget: 1e9,
    };
    // Everything is embedded: nothing to do.
    const idle = await processEmbeddings(ctx, fake);
    expect(idle).toMatchObject({ configured: true, provider: "fake", candidates: 0, done: 0 });

    // Three recordings lose their embedding; the step takes two per run (EMBED_MAX_PER_RUN) newest first.
    const three = await pool.query(`update interactions set embedded_at = null where id in (select id from interactions where embedded_at is not null order by occurred_at desc limit 3) returning id`);
    expect(three.rowCount).toBe(3);
    const run1 = await runWorker(ctx, { trigger: "test", steps: ["embed"] });
    expect(run1.ok).toBe(true);
    expect(run1.summary.embed).toMatchObject({ configured: true, candidates: 2, done: 2, failed: 0 });
    expect(run1.summary.embed!.chunks).toBeGreaterThan(0);
    const run2 = await runWorker(ctx, { trigger: "test", steps: ["embed"] });
    expect(run2.summary.embed).toMatchObject({ candidates: 1, done: 1 });
    expect((await pool.query(`select count(*)::int as n from interactions where embedded_at is null and exists (select 1 from segments s where s.interaction_id = interactions.id)`)).rows[0].n).toBe(0);

    // A provider outage: the recording keeps embed_error + attempts, pipeline_status is untouched, old chunks stay.
    const broken: EmbeddingProvider = { name: "broken", model: "x", dimensions: 1024, usdPerMillionTokens: 0, embed: async () => { throw new Error("HTTP 503: provider down"); } };
    const victim = await pool.query(`update interactions set embedded_at = null where id = (select id from interactions where embedded_at is not null order by id limit 1) returning id, pipeline_status`);
    const vid = victim.rows[0].id as number;
    const chunksBefore = (await pool.query(`select count(*)::int as n from chunks where interaction_id = $1`, [vid])).rows[0].n;
    const failed = await processEmbeddings(ctx, broken);
    expect(failed).toMatchObject({ candidates: 1, done: 0, failed: 1 });
    expect(failed.errors[0]).toMatch(/provider down/);
    const row = await pool.query(`select embed_error, embed_attempts, pipeline_status, embedded_at from interactions where id = $1`, [vid]);
    expect(row.rows[0].embed_error).toMatch(/provider down/);
    expect(row.rows[0].embed_attempts).toBeGreaterThan(0);
    expect(row.rows[0].pipeline_status).toBe(victim.rows[0].pipeline_status);
    expect(row.rows[0].embedded_at).toBeNull();
    expect((await pool.query(`select count(*)::int as n from chunks where interaction_id = $1`, [vid])).rows[0].n).toBe(chunksBefore);
    // The next healthy run retries it and clears the error.
    const recovered = await processEmbeddings(ctx, fake);
    expect(recovered).toMatchObject({ candidates: 1, done: 1, failed: 0 });
    expect((await pool.query(`select embed_error from interactions where id = $1`, [vid])).rows[0].embed_error).toBeNull();
    // Attempts are capped: a recording that failed MAX times is left alone until --retry-failed.
    await pool.query(`update interactions set embedded_at = null, embed_attempts = 5, embed_error = 'x' where id = $1`, [vid]);
    expect(await listEmbedCandidates(pool)).toEqual([]);
    expect((await listEmbedCandidates(pool, { retryFailed: true })).map((c) => c.id)).toEqual([vid]);
    await embedInteraction(pool, fake, vid);
    // The Pipeline page shows the counts.
    const pipeline = await owner.agent.get("/api/pipeline");
    expect(pipeline.status).toBe(200);
    expect(pipeline.body.embeddings).toMatchObject({ pending: 0, failed: 0 });
    expect(pipeline.body.embeddings.embedded).toBeGreaterThan(30);
  }, 60_000);
});
