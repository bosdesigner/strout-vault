// Context-aware auto-approval (docs/AUTO-APPLY.md), end to end on its own local database:
// propose_update over MCP (the insert still runs as mcp_proposer), the rules, the auto_applies log,
// the Review page's Auto-applied list and Undo, and the queue re-evaluation (dry run, then apply).
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { FakeEmbeddingProvider } from "../../server/embeddings/fake.ts";
import { amountsIn, evaluateProposal, normalize, phoneKey, routeReviewItemTx } from "../../server/services/autoApply.ts";
import { applyApproved, dryRun } from "../../scripts/reevaluate-review.ts";

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const STORAGE = path.join(REPO_ROOT, ".data/storage-auto");

let t: TestApp;
let http: Server;
let pool: pg.Pool;
let owner: Session;
let token: string;
let mcp: Client;
/** A text thread whose messages carry a name, phone, email, a promise and a price. */
let thread: number;
/** A recording with a speaker label and a known project mentioned by name. */
let call: number;
let projectId: number;

const csrf = () => ({ "x-csrf-token": owner.csrf });

async function tool<T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T & { error?: string }> {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function propose(item_type: string, proposal: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return tool("propose_update", { item_type, proposal, reason: "test", ...extra });
}

async function interaction(kind: string, title: string, lines: Array<[string, string]>): Promise<number> {
  const ins = await pool.query(`insert into interactions (workspace_id, kind, occurred_at, title) values ('another_story', $1, now(), $2) returning id`, [kind, title]);
  const id = Number(ins.rows[0].id);
  for (const [i, [speaker, text]] of lines.entries()) {
    await pool.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ($1, $2, $3, $4, $5, $6)`, [id, i, i * 30, i * 30 + 25, speaker, text]);
  }
  return id;
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const urls = await resetDatabase(server, "strout_vault_auto", { seed: true, storageDir: STORAGE, quiet: true });
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
    { mcp: { embeddings: new FakeEmbeddingProvider() } },
  );
  await new Promise<void>((resolve) => {
    http = t.app.listen(PORT, () => resolve());
  });
  owner = await login(t.app);
  const res = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "jarvis", workspaceScope: ["another_story"] });
  expect(res.status, res.text).toBe(201);
  token = res.body.token;
  mcp = new Client({ name: "vitest", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

  thread = await interaction("text_thread", "Texts with a new homeowner", [
    ["+16155550142", "Hi Ben, this is Dana Whitfield. My cell is (615) 555-0142 and email dana.whitfield@example.com"],
    ["Ben Strout", "Thanks Dana. I'll send you the porch drawings by Friday."],
    ["+16155550142", "Great. The framer quoted $12,500 for the porch."],
    ["+16155550142", "Also my husband Rob Whitfield can be reached at 615-555-0199."],
  ]);
  const proj = await pool.query(`insert into projects (workspace_id, name, address) values ('another_story', 'Whitfield Porch', '12 Elm Street') returning id`);
  projectId = Number(proj.rows[0].id);
  call = await interaction("call", "Call about the Whitfield Porch", [
    ["Speaker 1", "Morning, it's Dana Whitfield calling about the Whitfield Porch."],
    ["Speaker 2", "Good to hear from you."],
  ]);
}, 180_000);

afterAll(async () => {
  await mcp?.close();
  http?.closeAllConnections();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  await t?.close();
  await pool?.end();
});

describe("matching helpers", () => {
  it("normalizes text, phones and amounts the way the rules compare them", () => {
    expect(normalize("  Dana   Whitfield. ")).toBe("dana whitfield");
    expect(normalize("Dana’s house")).toBe("dana's house");
    expect(phoneKey("+1 (615) 555-0142")).toBe("6155550142");
    expect(phoneKey("615.555.0142")).toBe("6155550142");
    expect(amountsIn("quoted $12,500 and 12.5k and $1.2 million")).toEqual([12500, 12500, 1200000]);
  });
});

describe("propose_update with auto-apply", () => {
  let danaId: number;
  let danaAutoId: number;

  it("auto-applies a verbatim new_party from a message and says so", async () => {
    const r = await propose("new_party", { kind: "person", name: "Dana Whitfield", phones: ["+1 615-555-0142"], emails: ["dana.whitfield@example.com"] }, { interaction_id: thread });
    expect(r).toMatchObject({ applied: true, rule: "additive:new-party-verbatim", status: "approved" });
    expect(r.review_id).toBeGreaterThan(0);
    expect(r.auto_apply_id).toBeGreaterThan(0);
    danaAutoId = r.auto_apply_id;
    const party = await pool.query(`select id, name, phones, emails from parties where name = 'Dana Whitfield'`);
    expect(party.rows).toHaveLength(1);
    danaId = Number(party.rows[0].id);
    expect(r.changed).toEqual([`parties #${danaId}`]);
    const rq = await pool.query(`select status, decided_by, route from review_queue where id = $1`, [r.review_id]);
    expect(rq.rows[0]).toMatchObject({ status: "approved", decided_by: "auto" });
    // The audit row: what changed, the rule, the source quote and the undo steps.
    const log = await pool.query(`select * from auto_applies where id = $1`, [r.auto_apply_id]);
    expect(log.rows[0]).toMatchObject({ review_id: r.review_id, item_type: "new_party", rule: "additive:new-party-verbatim", source_interaction_id: thread, actor: "mcp:jarvis" });
    expect(log.rows[0].source_quote).toContain("this is Dana Whitfield");
    expect(log.rows[0].undo).toEqual([{ op: "delete", table: "parties", where: { id: danaId } }]);
  });

  it("queues an inferred lead type (role) even when the name and phone are verbatim", async () => {
    const r = await propose(
      "new_party",
      { kind: "person", name: "Rob Whitfield", phones: ["615-555-0199"], role: { workspace_id: "another_story", role: "client", detail: "homeowner lead" } },
      { interaction_id: thread },
    );
    expect(r).toMatchObject({ applied: false, rule: "inference:role", queued: true, status: "open" });
    expect(r.review_id).toBeGreaterThan(0);
    expect((await pool.query(`select 1 from parties where name = 'Rob Whitfield'`)).rowCount).toBe(0);
  });

  it("queues a phone edit to a party that already has a phone", async () => {
    const r = await propose("party_edit", { party_id: danaId, changes: { phones: ["615-555-0199"] } }, { interaction_id: thread });
    expect(r).toMatchObject({ applied: false, rule: "edits-existing:phone" });
    const party = await pool.query(`select phones from parties where id = $1`, [danaId]);
    expect(party.rows[0].phones).toEqual(["+1 615-555-0142"]);
    // A name change is an edit too.
    expect((await propose("party_edit", { party_id: danaId, changes: { name: "Dana W." } }, { interaction_id: thread })).rule).toBe("edits-existing:name");
  });

  it("queues a new party whose phone already belongs to someone (possible duplicate)", async () => {
    const r = await propose("new_party", { kind: "person", name: "Ben Strout", phones: ["(615) 555-0142"] }, { interaction_id: thread });
    expect(r.applied).toBe(false);
    expect([r.rule, ...(r.also ?? [])]).toContain("possible-duplicate:phone");
  });

  it("queues anything with no source to cite", async () => {
    const r = await propose("new_party", { kind: "person", name: "Morgan Lee", phones: ["615-555-0111"] });
    expect(r).toMatchObject({ applied: false, rule: "no-source" });
  });

  it("queues a name or number the source does not contain", async () => {
    const r = await propose("new_party", { kind: "person", name: "Dana Whitfeld", emails: ["dana@other.example.com"] }, { interaction_id: thread });
    expect(r.applied).toBe(false);
    expect(r.rule).toBe("not-verbatim:name");
  });

  it("auto-applies a commitment and a quoted price, queues a decision and low confidence", async () => {
    const promise = await propose("new_fact", { interaction_id: thread, kind: "commitment", text: "Ben will send Dana the porch drawings by Friday.", about_party_id: danaId, confidence: 0.9 }, { source_quote: "I'll send you the porch drawings by Friday." });
    expect(promise).toMatchObject({ applied: true, rule: "additive:fact-commitment-quoted" });
    const fact = await pool.query(`select f.id, f.quote, f.origin from facts f where f.text = 'Ben will send Dana the porch drawings by Friday.'`);
    expect(fact.rows[0]).toMatchObject({ quote: "I'll send you the porch drawings by Friday.", origin: "review" });

    const price = await propose("new_fact", { interaction_id: thread, kind: "price", text: "The framer quoted $12,500 for the porch.", amount: 12500 });
    expect(price).toMatchObject({ applied: true, rule: "additive:fact-price-quoted" });
    const wrongAmount = await propose("new_fact", { interaction_id: thread, kind: "price", text: "Porch framing is $15,000.", amount: 15000, confidence: 0.95 }, { source_quote: "The framer quoted $12,500 for the porch." });
    expect(wrongAmount).toMatchObject({ applied: false, rule: "not-verbatim:amount" });

    const decision = await propose("new_fact", { interaction_id: thread, kind: "decision", text: "Dana chose the porch.", confidence: 0.99 }, { source_quote: "The framer quoted $12,500 for the porch." });
    expect(decision).toMatchObject({ applied: false, rule: "inference:fact-decision" });
    const low = await propose("new_fact", { interaction_id: thread, kind: "task", text: "Dana will send the framer quote.", confidence: 0.6 }, { source_quote: "The framer quoted $12,500 for the porch." });
    expect(low).toMatchObject({ applied: false, rule: "low-confidence:0.60" });
    const fake = await propose("new_fact", { interaction_id: thread, kind: "commitment", text: "Dana will pay a deposit.", confidence: 0.95 }, { source_quote: "I will pay the deposit tomorrow" });
    expect(fake).toMatchObject({ applied: false, rule: "quote-not-in-source" });
  });

  it("auto-applies tagging a party and a project the transcript names, and queues a speaker label already taken", async () => {
    const tag = await propose("link_party_interaction", { party_id: danaId, interaction_id: call, speaker_label: "Speaker 1" });
    expect(tag).toMatchObject({ applied: true, rule: "additive:link-party" });
    const seg = await pool.query(`select count(*)::int as n from segments where interaction_id = $1 and speaker_party_id = $2`, [call, danaId]);
    expect(seg.rows[0].n).toBe(1);
    const proj = await propose("link_project_interaction", { project_id: projectId, interaction_id: call });
    expect(proj).toMatchObject({ applied: true, rule: "additive:link-project" });
    const other = (await pool.query(`select id from parties where id <> $1 and merged_into is null order by id limit 1`, [danaId])).rows[0].id;
    const clash = await propose("link_party_interaction", { party_id: Number(other), interaction_id: call, speaker_label: "Speaker 1", confidence: 0.99 });
    expect(clash.applied).toBe(false);
    expect([clash.rule, ...(clash.also ?? [])]).toContain("conflict:speaker-label-taken");
  });

  it("adds a phone to a party that has none, and a new relationship always queues", async () => {
    const org = await pool.query(`insert into parties (kind, name) values ('person', 'Rob Whitfield') returning id`);
    const robId = Number(org.rows[0].id);
    const add = await propose("party_edit", { party_id: robId, changes: { phones: ["615-555-0199"] } }, { interaction_id: thread });
    expect(add).toMatchObject({ applied: true, rule: "additive:contact-added" });
    expect((await pool.query(`select phones from parties where id = $1`, [robId])).rows[0].phones).toEqual(["615-555-0199"]);
    const rel = await propose("new_relationship", { from_party_id: robId, to_party_id: danaId, kind: "spouse" }, { interaction_id: thread });
    expect(rel).toMatchObject({ applied: false, rule: "inference:relationship" });

    // Undo removes only the phone it added.
    const id = (await pool.query(`select id from auto_applies where review_id = $1`, [add.review_id])).rows[0].id;
    const undo = await owner.agent.post(`/api/review/auto-applied/${id}/undo`).set(csrf()).send({});
    expect(undo.status, undo.text).toBe(200);
    expect((await pool.query(`select phones from parties where id = $1`, [robId])).rows[0].phones).toEqual([]);
  });

  it("lists the last 7 days on the Auto-applied tab, and Undo reverses an auto-apply", async () => {
    const list = await owner.agent.get("/api/review/auto-applied?days=7");
    expect(list.status).toBe(200);
    const rules = list.body.items.map((i: { rule: string }) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["additive:new-party-verbatim", "additive:fact-commitment-quoted", "additive:link-party", "additive:link-project"]));
    const item = list.body.items.find((i: { rule: string }) => i.rule === "additive:link-party");
    expect(item.sourceQuote).toContain("Dana Whitfield");
    expect(item.item).toMatchObject({ itemType: "link_party_interaction", decidedBy: "auto" });

    // Undo the tag: the participant row and the speaker's lines go back to unassigned.
    const tagUndo = await owner.agent.post(`/api/review/auto-applied/${item.id}/undo`).set(csrf()).send({});
    expect(tagUndo.status, tagUndo.text).toBe(200);
    expect((await pool.query(`select 1 from interaction_participants where interaction_id = $1 and party_id = $2`, [call, item.item.party.id])).rowCount).toBe(0);
    expect((await pool.query(`select count(*)::int as n from segments where interaction_id = $1 and speaker_party_id is not null`, [call])).rows[0].n).toBe(0);
    const rq = await pool.query(`select status, decided_by from review_queue where id = $1`, [item.reviewId]);
    expect(rq.rows[0]).toEqual({ status: "rejected", decided_by: "undo" });
    expect((await owner.agent.post(`/api/review/auto-applied/${item.id}/undo`).set(csrf()).send({})).status).toBe(409);

    // A party something now points at cannot be silently deleted: undo refuses and changes nothing.
    const blocked = await owner.agent.post(`/api/review/auto-applied/${danaAutoId}/undo`).set(csrf()).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/cannot undo/);
    expect((await pool.query(`select 1 from parties where id = $1`, [danaId])).rowCount).toBe(1);
  });

  it("Undo of a new party deletes it when nothing else uses it", async () => {
    const r = await propose("new_party", { kind: "org", name: "Whitfield Porch" }, { interaction_id: call });
    expect(r).toMatchObject({ applied: true });
    const partyId = Number(r.changed[0].replace(/\D/g, ""));
    expect((await pool.query(`select 1 from parties where id = $1`, [partyId])).rowCount).toBe(1);
    const undo = await owner.agent.post(`/api/review/auto-applied/${r.auto_apply_id}/undo`).set(csrf()).send({});
    expect(undo.status, undo.text).toBe(200);
    expect((await pool.query(`select 1 from parties where id = $1`, [partyId])).rowCount).toBe(0);
    const log = await pool.query(`select undone_at, undone_by from auto_applies where id = $1`, [r.auto_apply_id]);
    expect(log.rows[0].undone_at).toBeTruthy();
    expect(log.rows[0].undone_by).toBe("owner@test.local");
  });

  it("with AUTO_APPLY=off an eligible proposal stays queued", async () => {
    const id = Number(
      (await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ('link_project_interaction', $1::jsonb, 'r', $2, 'open') returning id`, [JSON.stringify({ project_id: projectId, interaction_id: call }), call])).rows[0].id,
    );
    const r = await routeReviewItemTx(pool, id, { actor: "test", enabled: false });
    expect(r).toMatchObject({ applied: false, rule: "auto-apply-off" });
    expect((await pool.query(`select status from review_queue where id = $1`, [id])).rows[0].status).toBe("open");
    await pool.query(`update review_queue set status = 'rejected' where id = $1`, [id]);
  });
});

describe("re-evaluating the open queue", () => {
  it("dry run lists would-auto-apply and would-stay-queued without changing anything; apply does exactly the approved list", async () => {
    // Queue three items the old way (as the extractor and older agents did): one eligible, two not.
    const q = async (type: string, proposal: Record<string, unknown>, reason: string, interactionId: number | null) =>
      Number((await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ($1, $2::jsonb, $3, $4, 'open') returning id`, [type, JSON.stringify(proposal), reason, interactionId])).rows[0].id);
    const eligible = await q("new_fact", { interaction_id: thread, kind: "followup", text: "Dana asked Ben to call Rob Whitfield.", quote_start_sec: 90, confidence: 0.88, source: "extract" }, "“Also my husband Rob Whitfield can be reached at 615-555-0199.” at 1:30", thread);
    const inference = await q("new_fact", { interaction_id: thread, kind: "issue", text: "Porch budget is tight.", confidence: 0.95, source: "extract" }, "“The framer quoted $12,500 for the porch.” at 1:00", thread);
    const workspace = await q("workspace_assignment", { workspace_id: "another_story" }, "filing", thread);
    const openBefore = Number((await pool.query(`select count(*)::int as n from review_queue where status = 'open'`)).rows[0].n);

    const d = await dryRun(pool);
    expect(d.open_before).toBe(openBefore);
    expect(d.would_auto_apply.length + d.would_stay_queued.length).toBe(openBefore);
    const auto = d.would_auto_apply.find((r) => r.review_id === eligible)!;
    expect(auto).toMatchObject({ item_type: "new_fact", rule: "additive:fact-followup-quoted", interaction_id: thread });
    expect(auto.quote).toContain("Rob Whitfield");
    expect(d.would_stay_queued.find((r) => r.review_id === inference)).toMatchObject({ rule: "inference:fact-issue" });
    expect(d.would_stay_queued.find((r) => r.review_id === workspace)).toMatchObject({ rule: "not-additive:workspace_assignment" });
    // Nothing changed.
    expect(Number((await pool.query(`select count(*)::int as n from review_queue where status = 'open'`)).rows[0].n)).toBe(openBefore);

    const report = await applyApproved(pool, d);
    expect(report.open_before).toBe(openBefore);
    expect(report.open_after).toBe(openBefore - d.would_auto_apply.length);
    expect(report.applied.map((a) => a.review_id).sort()).toEqual(d.would_auto_apply.map((a) => a.review_id).sort());
    expect((await pool.query(`select status from review_queue where id = any($1::bigint[])`, [[inference, workspace]])).rows.every((r) => r.status === "open")).toBe(true);
    expect((await pool.query(`select actor from auto_applies where review_id = $1`, [eligible])).rows[0].actor).toBe("reevaluate");
  });

  it("the evaluator reads only: it never writes during a dry run", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin read only");
      const d = await evaluateProposal(client, { itemType: "new_party", proposal: { kind: "person", name: "Dana Whitfield" }, reason: null, interactionId: thread });
      expect(d.auto).toBe(false); // Dana exists now: possible duplicate by name
      expect(d.reasons).toContain("possible-duplicate:name");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
