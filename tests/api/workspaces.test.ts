// Filing unassigned recordings under workspaces: the proposer (dry run and apply), approval
// on the Review page writing interactions.workspace_id, bulk approval, and the MCP server's
// explicit "unassigned" scope. Own database; nothing reaches Neon.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { collectSignals, proposeWorkspaces, queueProposals, WORKSPACE_ITEM_TYPE } from "../../server/workspaces/propose.ts";
import { resolveScope, scopeSql, inScope, describeScope } from "../../server/mcp/scope.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-workspaces");
let t: TestApp;
let pool: pg.Pool;
let owner: Session;
const csrf = () => ({ "x-csrf-token": owner.csrf });

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const { url } = await resetDatabase(server, "strout_vault_workspaces", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: url, max: 4 });
  t = await buildTestApp({ DATABASE_URL: url, LOCAL_STORAGE_DIR: STORAGE, PUBLIC_URL: "http://localhost:3997" });
  owner = await login(t.app);
  // Production has no workspace on any recording; make the seed look like that.
  await pool.query(`update interactions set workspace_id = null`);
}, 180_000);

afterAll(async () => {
  await t?.close();
  await pool?.end();
});

describe("workspace proposer", () => {
  it("gathers title, people and transcript signals for every unassigned recording", async () => {
    const { signals } = await collectSignals(pool);
    expect(signals.length).toBe(40);
    // The seeded shutter conversations say "shutters" a lot; the seeded Phalanx ones never say "Phalanx".
    const shutters = signals.find((s) => s.title === "Shutter hardware options")!;
    expect(shutters.transcriptHits.southern_shutter).toBeGreaterThan(0);
    expect(shutters.segmentCount).toBeGreaterThan(0);
    const phalanx = signals.find((s) => s.title === "Phalanx pilot scope with Daniel")!;
    expect(phalanx.transcriptHits.phalanx).toBe(0);
    // Known people are matched on their full name only; a bare first name in a title is not a hit.
    expect(signals.find((s) => s.title === "Mudroom layout with Maria")!.peopleInTitle).toEqual([]);
    await pool.query(`update interactions set title = 'Kickoff with Maria Delgado' where title = 'Mudroom layout with Maria'`);
    const again = await collectSignals(pool);
    expect(again.signals.find((s) => s.title === "Kickoff with Maria Delgado")!.peopleInTitle).toEqual([{ name: "Maria Delgado", workspaceId: "strout_arch", strong: true }]);
  });

  it("dry run proposes the obvious ones with evidence, leaves the rest undecided, and writes nothing", async () => {
    const before = (await pool.query(`select count(*)::int as n from review_queue`)).rows[0].n;
    const report = await proposeWorkspaces(pool);
    expect(report.candidates).toBe(40);
    expect(report.proposed.length).toBeGreaterThan(5);
    const byTitle = new Map<number, string>();
    for (const r of (await pool.query(`select id, title from interactions`)).rows) byTitle.set(Number(r.id), r.title);
    const pick = (title: string) => report.proposed.find((p) => byTitle.get(p.interactionId) === title);
    expect(pick("Phalanx pilot scope with Daniel")).toMatchObject({ workspaceId: "phalanx", confidence: 0.9 }); // title rule only
    expect(pick("Kickoff with Maria Delgado")).toMatchObject({ workspaceId: "strout_arch" }); // known person in the title
    expect(pick("Shutter hardware options")).toMatchObject({ workspaceId: "southern_shutter" }); // title + transcript agree
    expect(pick("Shutter hardware options")!.confidence).toBeGreaterThanOrEqual(0.9);
    // Some recordings are filed on transcript vocabulary alone.
    expect(report.proposed.some((p) => p.evidence.length === 1 && /transcript line/.test(p.evidence[0]))).toBe(true);
    for (const p of report.proposed) {
      expect(p.confidence).toBeGreaterThanOrEqual(0.6);
      expect(p.evidence.length).toBeGreaterThan(0);
    }
    expect(report.undecided.length).toBeGreaterThan(0);
    expect(Object.values(report.byWorkspace).reduce((a, b) => a + b, 0)).toBe(report.proposed.length);
    expect((await pool.query(`select count(*)::int as n from review_queue`)).rows[0].n).toBe(before);
    // A first pass can be limited to one workspace.
    const only = await proposeWorkspaces(pool, { onlyWorkspace: "phalanx" });
    expect(only.proposed.every((p) => p.workspaceId === "phalanx")).toBe(true);
  });

  it("apply queues review items once; approving one files the recording, bulk approves the rest", async () => {
    const report = await proposeWorkspaces(pool);
    const ids = await queueProposals(pool, report.proposed, "test");
    expect(ids.length).toBe(report.proposed.length);
    const row = await pool.query(`select item_type, status, interaction_id, proposal, reason from review_queue where id = $1`, [ids[0]]);
    expect(row.rows[0]).toMatchObject({ item_type: WORKSPACE_ITEM_TYPE, status: "open", interaction_id: report.proposed[0].interactionId });
    expect(row.rows[0].proposal).toMatchObject({ workspace_id: report.proposed[0].workspaceId, source: "workspace-proposer" });
    expect(row.rows[0].reason).toMatch(/^File ".*" under /);
    // Re-running skips recordings that already wait for review.
    const again = await proposeWorkspaces(pool);
    expect(again.skippedOpenProposal).toBe(ids.length);
    expect(again.proposed).toEqual([]);

    // Approve one on the Review page: the recording gets its workspace.
    const first = report.proposed[0];
    const decided = await owner.agent.post(`/api/review/${ids[0]}/decide`).set(csrf()).send({ decision: "approve" });
    expect(decided.status, decided.text).toBe(200);
    expect(decided.body.applied).toEqual([`interactions.workspace_id = ${first.workspaceId}`]);
    expect((await pool.query(`select workspace_id from interactions where id = $1`, [first.interactionId])).rows[0].workspace_id).toBe(first.workspaceId);
    // Rejecting leaves the recording alone.
    const second = report.proposed[1];
    await owner.agent.post(`/api/review/${ids[1]}/decide`).set(csrf()).send({ decision: "reject" });
    expect((await pool.query(`select workspace_id from interactions where id = $1`, [second.interactionId])).rows[0].workspace_id).toBeNull();
    // Bulk approve the rest.
    const rest = ids.slice(2);
    const bulk = await owner.agent.post("/api/review/bulk").set(csrf()).send({ ids: rest, decision: "approve" });
    expect(bulk.status, bulk.text).toBe(200);
    expect(bulk.body).toMatchObject({ done: rest.length, failed: [] });
    const filed = await pool.query(`select count(*)::int as n from interactions where workspace_id is not null`);
    expect(filed.rows[0].n).toBe(1 + rest.length);
    const open = await pool.query(`select count(*)::int as n from review_queue where item_type = $1 and status = 'open'`, [WORKSPACE_ITEM_TYPE]);
    expect(open.rows[0].n).toBe(0);
    // The list endpoint shows the label fields the page needs.
    const list = await owner.agent.get("/api/review?status=all");
    expect(list.body.items.some((it: { itemType: string; proposal: { workspace_id?: string } }) => it.itemType === WORKSPACE_ITEM_TYPE && it.proposal.workspace_id)).toBe(true);
  });

  it("refuses a proposal for an unknown workspace", async () => {
    const rec = await pool.query(`select id from interactions where workspace_id is null limit 1`);
    const { rows } = await pool.query(`insert into review_queue (item_type, proposal, reason, interaction_id, status) values ($1, $2::jsonb, 'x', $3, 'open') returning id`, [WORKSPACE_ITEM_TYPE, JSON.stringify({ interaction_id: rec.rows[0].id, workspace_id: "nope" }), rec.rows[0].id]);
    const res = await owner.agent.post(`/api/review/${rows[0].id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(res.status).toBe(400);
    expect((await pool.query(`select status from review_queue where id = $1`, [rows[0].id])).rows[0].status).toBe("open");
  });
});

describe("the unassigned scope", () => {
  it("is explicit: '*' never implies it, and it renders an IS NULL predicate", async () => {
    const star = await resolveScope(pool, ["*"]);
    expect(star.unassigned).toBe(false);
    expect(inScope(star, null)).toBe(false);
    const withUnassigned = await resolveScope(pool, ["*", "unassigned"]);
    expect(withUnassigned.unassigned).toBe(true);
    expect(inScope(withUnassigned, null)).toBe(true);
    const params: unknown[] = [];
    expect(scopeSql(withUnassigned, params)).toMatch(/^\(i\.workspace_id = any\(\$1::text\[\]\) or i\.workspace_id is null\)$/);
    const only = await resolveScope(pool, ["unassigned"]);
    expect(scopeSql(only, [])).toBe("i.workspace_id is null");
    expect(describeScope(["*", "unassigned"])).toBe("all workspaces except phalanx + unassigned recordings");
    expect(describeScope(["unassigned"])).toBe("no workspaces + unassigned recordings");
  });

  it("a token with 'unassigned' sees the unfiled recordings through the MCP tools; a '*' token does not", async () => {
    const unfiled = (await pool.query(`select count(*)::int as n from interactions where workspace_id is null`)).rows[0].n;
    expect(unfiled).toBeGreaterThan(0);
    const mint = async (name: string, workspaceScope: string[]) => {
      const res = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name, workspaceScope });
      expect(res.status, res.text).toBe(201);
      return res.body.token as string;
    };
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await owner.agent
        .post("/mcp")
        .set("authorization", `Bearer ${token}`)
        .set("accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      expect(res.status, res.text).toBe(200);
      const body = typeof res.body === "object" && res.body.result ? res.body : JSON.parse(res.text);
      return JSON.parse(body.result.content[0].text);
    };
    const star = await mint("star", ["*"]);
    const un = await mint("unassigned", ["unassigned"]);
    const both = await mint("both", ["*", "unassigned"]);
    // Initialize is not required in stateless mode, but the SDK client would send it; a raw tools/call works too.
    const starList = await call(star, "list_interactions", { limit: 50 });
    expect(starList.items.every((i: { workspace_id: string | null }) => i.workspace_id !== null)).toBe(true);
    const unList = await call(un, "list_interactions", { limit: 50 });
    expect(unList.items.length).toBe(Math.min(50, unfiled));
    expect(unList.items.every((i: { workspace_id: string | null }) => i.workspace_id === null)).toBe(true);
    const bothList = await call(both, "list_interactions", { workspace: "unassigned", limit: 50 });
    expect(bothList.items.length).toBe(Math.min(50, unfiled));
    const refused = await call(star, "list_interactions", { workspace: "unassigned" });
    expect(refused).toMatchObject({ count: 0 });
    expect(refused.note).toMatch(/not within this token's scope/);
    const search = await call(un, "search_conversations", { query: "copper gutters", mode: "keyword", limit: 50 });
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.every((r: { workspace_id: string | null }) => r.workspace_id === null)).toBe(true);
    const unfiledId = (await pool.query(`select id from interactions where workspace_id is null and exists (select 1 from segments s where s.interaction_id = interactions.id) limit 1`)).rows[0].id;
    expect((await call(star, "get_interaction", { id: unfiledId })).error).toBe("not_found");
    expect((await call(un, "get_interaction", { id: unfiledId })).id).toBe(unfiledId);
    const proposal = await call(un, "propose_update", { item_type: "new_fact", proposal: { interaction_id: unfiledId, kind: "decision", text: "x" }, reason: "r" });
    expect(proposal.queued).toBe(true);
  });
});
