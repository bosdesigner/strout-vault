import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import type { PersonDetail, PersonListItem, ProjectDetail, ProjectListItem, RecordingDetail, ReviewItem } from "../../shared/types.ts";

let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await buildTestApp();
  s = await login(t.app);
});
afterAll(() => t.close());

const csrf = () => ({ "x-csrf-token": s.csrf });
const people = async (qs = "") => (await s.agent.get(`/api/parties${qs ? `?${qs}` : ""}`)).body.items as PersonListItem[];

describe("people and companies", () => {
  it("lists everyone with role chips per workspace", async () => {
    const all = await people();
    expect(all).toHaveLength(16);
    const kevin = all.find((p) => p.name === "Kevin McGuire")!;
    expect(kevin.roles).toEqual([expect.objectContaining({ workspaceId: "another_story", workspaceName: "Another Story", role: "contractor", market: "Houston (Conroe)" })]);
    expect(kevin.detail).toBe("Another Story · contractor");
    expect(kevin.interactionCount).toBeGreaterThan(0);
    const lena = all.find((p) => p.name === "Lena Fischer")!;
    expect(lena.orgs).toEqual([{ id: expect.any(Number), name: "Gulf Coast Millwork" }]);
  });

  it("filters by workspace, role, status, market, kind and text", async () => {
    expect((await people("workspace=another_story")).map((p) => p.name).sort()).toEqual(["Ben Strout", "Kevin McGuire", "Sam Whitaker"]);
    expect((await people("role=contractor")).map((p) => p.name).sort()).toEqual(["Carlos Mendes", "Kevin McGuire", "Sam Whitaker"]);
    expect((await people("status=prospect")).map((p) => p.name).sort()).toEqual(["Jordan Ellis", "Nora Bennett"]);
    expect((await people("market=Conroe")).map((p) => p.name)).toEqual(["Kevin McGuire"]);
    expect((await people("workspace=strout_arch&role=client&status=active")).map((p) => p.name)).toEqual(["Maria Delgado"]);
    expect((await people("kind=org")).every((p) => p.kind === "org")).toBe(true);
    expect((await people("kind=org")).length).toBe(4);
    expect((await people("q=mc"))[0].name).toBe("Kevin McGuire");
    expect((await people("q=gulf"))[0].kind).toBe("org");
    expect((await s.agent.get("/api/parties?role=wizard")).status).toBe(400);
  });

  it("lists markets for the filter", async () => {
    const res = await s.agent.get("/api/parties/markets");
    expect(res.body.items).toContain("Houston (Conroe)");
    const ws = await s.agent.get("/api/parties/markets?workspace=credvault");
    expect(ws.body.items).toEqual(["Austin"]);
  });

  it("returns the full person page: contact, roles, affiliations, timeline, open facts, projects", async () => {
    const id = (await people("q=Maria"))[0].id;
    const res = await s.agent.get(`/api/parties/${id}`);
    expect(res.status).toBe(200);
    const p = res.body as PersonDetail;
    expect(p.emails).toEqual(["maria.delgado@example.com"]);
    expect(p.roles[0]).toMatchObject({ workspaceId: "strout_arch", role: "client", market: "Houston (Heights)" });
    expect(p.interactions.length).toBeGreaterThan(2);
    expect(p.projects.map((x) => x.name)).toContain("Heights Bungalow Addition");
    expect(p.facts.length).toBeGreaterThan(0);
    for (const f of p.facts) expect(f.ownerParty?.id === id || f.aboutParty?.id === id).toBe(true);
  });

  it("edits contact fields and the name", async () => {
    const id = (await people("q=Nora"))[0].id;
    const res = await s.agent.patch(`/api/parties/${id}`).set(csrf()).send({ emails: ["nora@example.com", "nb@example.com"], location: "Lake Travis, TX", website: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual(["nora@example.com", "nb@example.com"]);
    expect(res.body.location).toBe("Lake Travis, TX");
    expect((await s.agent.patch(`/api/parties/${id}`).set(csrf()).send({ bogus: 1 })).status).toBe(400);
    expect((await s.agent.patch(`/api/parties/${id}`).send({ name: "x" })).status).toBe(403);
    const back = await s.agent.patch(`/api/parties/${id}`).set(csrf()).send({ emails: ["nora.bennett@example.com"], location: "Austin, TX", website: null });
    expect(back.status).toBe(200);
  });

  it("adds and updates roles (never deletes; mark former instead)", async () => {
    const id = (await people("q=Rachel"))[0].id;
    const add = await s.agent.post(`/api/parties/${id}/roles`).set(csrf()).send({ workspaceId: "credvault", role: "advisor", market: "Houston", detail: "energy angle" });
    expect(add.status).toBe(201);
    const role = (add.body as PersonDetail).roles.find((r) => r.workspaceId === "credvault")!;
    expect(role).toMatchObject({ role: "advisor", status: "active", market: "Houston" });
    // Same (workspace, party, role) again updates instead of duplicating.
    const again = await s.agent.post(`/api/parties/${id}/roles`).set(csrf()).send({ workspaceId: "credvault", role: "advisor", status: "paused" });
    expect((again.body as PersonDetail).roles.filter((r) => r.workspaceId === "credvault")).toHaveLength(1);
    const former = await s.agent.patch(`/api/roles/${role.id}`).set(csrf()).send({ status: "former" });
    expect(former.status).toBe(200);
    expect((former.body as PersonDetail).roles.find((r) => r.id === role.id)?.status).toBe("former");
    expect((await s.agent.post(`/api/parties/${id}/roles`).set(csrf()).send({ workspaceId: "nope", role: "advisor" })).status).toBe(400);
  });

  it("creates a person with a first role and links an organization", async () => {
    const created = await s.agent.post("/api/parties").set(csrf()).send({ kind: "person", name: "Dana Whitfield", emails: ["dana@example.com"], role: { workspaceId: "phalanx", role: "prospect", market: "Dallas" } });
    expect(created.status).toBe(201);
    const dana = created.body as PersonDetail;
    expect(dana.roles[0]).toMatchObject({ workspaceId: "phalanx", role: "prospect" });
    expect((await people("workspace=phalanx")).some((p) => p.name === "Dana Whitfield")).toBe(true);
    const org = (await people("q=Harbor"))[0];
    const aff = await s.agent.post(`/api/parties/${dana.id}/affiliations`).set(csrf()).send({ orgId: org.id, title: "Analyst" });
    expect(aff.status).toBe(201);
    expect((aff.body as PersonDetail).affiliations[0]).toMatchObject({ title: "Analyst", other: { name: "Harbor Point Capital" } });
  });
});

describe("projects", () => {
  it("lists projects with counts, scoped by workspace", async () => {
    const all = (await s.agent.get("/api/projects")).body.items as ProjectListItem[];
    expect(all).toHaveLength(6);
    const heights = all.find((p) => p.name === "Heights Bungalow Addition")!;
    expect(heights.partyCount).toBe(3);
    expect(heights.interactionCount).toBeGreaterThan(0);
    const arch = (await s.agent.get("/api/projects?workspace=strout_arch")).body.items as ProjectListItem[];
    expect(arch.map((p) => p.name).sort()).toEqual(["Bennett Lake House", "Heights Bungalow Addition"]);
  });

  it("returns parties with roles, linked interactions and facts; edits fields; adds people", async () => {
    const list = (await s.agent.get("/api/projects?q=Heights")).body.items as ProjectListItem[];
    const id = list[0].id;
    const res = await s.agent.get(`/api/projects/${id}`);
    const p = res.body as ProjectDetail;
    expect(p.parties.map((x) => `${x.name}:${x.projectRole}`).sort()).toEqual(["Carlos Mendes:site_super", "Maria Delgado:client", "Oakridge Builders:gc"]);
    expect(p.parties.find((x) => x.name === "Maria Delgado")!.roles[0].role).toBe("client");
    expect(p.interactions.length).toBeGreaterThan(0);
    expect(p.facts.length).toBeGreaterThan(0);

    const edit = await s.agent.patch(`/api/projects/${id}`).set(csrf()).send({ status: "punch list", notes: "Final walkthrough Friday." });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe("punch list");
    await s.agent.patch(`/api/projects/${id}`).set(csrf()).send({ status: "construction", notes: null });

    const permits = (await people("q=Bayou"))[0];
    const added = await s.agent.post(`/api/projects/${id}/parties`).set(csrf()).send({ partyId: permits.id, role: "expediter" });
    expect(added.status).toBe(201);
    expect((added.body as ProjectDetail).parties.some((x) => x.name === "Bayou City Permits" && x.projectRole === "expediter")).toBe(true);
  });

  it("creates a project", async () => {
    const res = await s.agent.post("/api/projects").set(csrf()).send({ workspaceId: "sepp", name: "Community Center Solar", address: "Conroe, TX", status: "proposal" });
    expect(res.status).toBe(201);
    expect(res.body.workspaceName).toBe("SEPP");
    expect((await s.agent.post("/api/projects").set(csrf()).send({ workspaceId: "nope", name: "x" })).status).toBe(400);
  });
});

describe("review queue", () => {
  it("lists open proposals with the person, speaker label and the moment in the call", async () => {
    const res = await s.agent.get("/api/review");
    expect(res.status).toBe(200);
    const items = res.body.items as ReviewItem[];
    expect(items.length).toBe(5);
    expect(res.body.openCount).toBe(5);
    for (const it of items) {
      expect(it.status).toBe("open");
      expect(it.itemType).toBe("participant_match");
      expect(it.reason).toMatch(/^Speaker \d is probably .+ \(0\.\d\d\)$/);
      expect(it.party?.name).toBeTruthy();
      expect(it.speakerLabel).toMatch(/^Speaker \d$/);
      expect(it.interaction?.id).toBeGreaterThan(0);
      expect(it.startSec).not.toBeNull();
    }
    const scoped = await s.agent.get("/api/review?workspace=strout_arch");
    for (const it of scoped.body.items as ReviewItem[]) expect(it.interaction?.workspaceId).toBe("strout_arch");
  });

  it("approving a participant match tags the person, assigns their lines and closes the item", async () => {
    const items = (await s.agent.get("/api/review")).body.items as ReviewItem[];
    const it = items[0];
    const interactionId = it.interaction!.id;
    const partyId = it.party!.id;
    const before = await t.dbHandle.pool.query(`select count(*)::int as n from segments where interaction_id = $1 and speaker = $2 and speaker_party_id is null`, [interactionId, it.speakerLabel]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    const taggedBefore = (await t.dbHandle.pool.query(`select speaker_label from interaction_participants where interaction_id = $1 and party_id = $2`, [interactionId, partyId])).rows[0];
    expect(taggedBefore?.speaker_label ?? null).toBeNull();

    const res = await s.agent.post(`/api/review/${it.id}/decide`).set(csrf()).send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("approved");
    expect(res.body.item.decidedAt).toBeTruthy();
    expect(res.body.applied).toEqual(["interaction_participants", expect.stringMatching(/^segments\.speaker_party_id \(\d+ lines\)$/)]);

    const ip = await t.dbHandle.pool.query(`select speaker_label, confidence from interaction_participants where interaction_id = $1 and party_id = $2`, [interactionId, partyId]);
    expect(ip.rows[0]).toMatchObject({ speaker_label: it.speakerLabel });
    const after = await t.dbHandle.pool.query(`select count(*)::int as n from segments where interaction_id = $1 and speaker = $2 and speaker_party_id = $3`, [interactionId, it.speakerLabel, partyId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const rq = await t.dbHandle.pool.query(`select status from review_queue where id = $1`, [it.id]);
    expect(rq.rows[0].status).toBe("approved");

    // The recording page now shows the person and links the speaker's lines.
    const rec = (await s.agent.get(`/api/interactions/${interactionId}`)).body as RecordingDetail;
    expect(rec.participants.some((p) => p.id === partyId && p.speakerLabel === it.speakerLabel)).toBe(true);
    const lines = (await s.agent.get(`/api/interactions/${interactionId}/segments`)).body.lines as Array<{ speaker: string; speakerPartyId: number | null }>;
    expect(lines.filter((l) => l.speaker === it.speakerLabel).every((l) => l.speakerPartyId === partyId)).toBe(true);

    expect((await s.agent.post(`/api/review/${it.id}/decide`).set(csrf()).send({ decision: "reject" })).status).toBe(409);
    expect((await s.agent.get("/api/review/count")).body.openCount).toBe(4);
  });

  it("rejecting marks the item without touching participants or segments", async () => {
    const it = ((await s.agent.get("/api/review")).body.items as ReviewItem[])[0];
    const res = await s.agent.post(`/api/review/${it.id}/decide`).set(csrf()).send({ decision: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("rejected");
    expect(res.body.applied).toEqual([]);
    const tagged = (await t.dbHandle.pool.query(`select speaker_label from interaction_participants where interaction_id = $1 and party_id = $2`, [it.interaction!.id, it.party!.id])).rows[0];
    expect(tagged?.speaker_label ?? null).toBeNull();
    const assigned = await t.dbHandle.pool.query(`select count(*)::int as n from segments where interaction_id = $1 and speaker = $2 and speaker_party_id = $3`, [it.interaction!.id, it.speakerLabel, it.party!.id]);
    expect(assigned.rows[0].n).toBe(0);
    const all = (await s.agent.get("/api/review?status=all")).body.items as ReviewItem[];
    expect(all.find((x) => x.id === it.id)?.status).toBe("rejected");
    expect((await s.agent.post(`/api/review/999999/decide`).set(csrf()).send({ decision: "approve" })).status).toBe(404);
  });
});

describe("tagging on the recording page", () => {
  it("adds a participant with a speaker label and assigns the lines", async () => {
    const { rows } = await t.dbHandle.pool.query(
      `select i.id, s.speaker from interactions i join segments s on s.interaction_id = i.id
       where s.speaker_party_id is null and s.speaker like 'Speaker %' group by i.id, s.speaker order by i.id limit 1`,
    );
    const { id, speaker } = rows[0];
    const sam = (await people("q=Sam"))[0];
    const speakers = await s.agent.get(`/api/interactions/${id}/speakers`);
    expect(speakers.body.items.some((x: { label: string; partyId: number | null }) => x.label === speaker && x.partyId === null)).toBe(true);
    const res = await s.agent.post(`/api/interactions/${id}/participants`).set(csrf()).send({ partyId: sam.id, speakerLabel: speaker });
    expect(res.status).toBe(201);
    expect(res.body.linesAssigned).toBeGreaterThan(0);
    const rec = res.body.recording as RecordingDetail;
    expect(rec.participants.some((p) => p.id === sam.id && p.speakerLabel === speaker)).toBe(true);
    expect(rec.speakers.find((x) => x.label === speaker)?.partyId).toBe(sam.id);
    expect((await s.agent.post(`/api/interactions/${id}/participants`).set(csrf()).send({ partyId: 987654 })).status).toBe(400);
  });

  it("links a project by hand", async () => {
    const rec = (await s.agent.get("/api/interactions?limit=1")).body.items[0];
    const project = ((await s.agent.get("/api/projects?q=Conroe Shoot")).body.items as ProjectListItem[])[0];
    const res = await s.agent.post(`/api/interactions/${rec.id}/projects`).set(csrf()).send({ projectId: project.id });
    expect(res.status).toBe(201);
    expect((res.body as RecordingDetail).projects.map((p) => p.id)).toContain(project.id);
    // Idempotent.
    expect((await s.agent.post(`/api/interactions/${rec.id}/projects`).set(csrf()).send({ projectId: project.id })).status).toBe(201);
    const detail = (await s.agent.get(`/api/projects/${project.id}`)).body as ProjectDetail;
    expect(detail.interactions.some((i) => i.id === rec.id)).toBe(true);
  });
});
