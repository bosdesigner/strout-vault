// Jarvis step 3: leads from the platform (a stand-in AnotherStoryBLDR database) and Airtable (a
// mock of the REST API) become parties with a prospect role. Local databases only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT, type LocalServer } from "../../scripts/lib/localdb.ts";
import { loadConfig, type Config } from "../../server/config.ts";
import { LocalStorageDriver } from "../../server/storage/local.ts";
import type { WorkerContext } from "../../server/worker/context.ts";
import { formatRunSummary, runWorker } from "../../server/worker/run.ts";
import { listLeads } from "../../server/mcp/tools/leads.ts";
import { getParty } from "../../server/mcp/tools/parties.ts";
import { listLeadPeople } from "../../server/services/leads.ts";
import { normalizePhone } from "../../server/leads/sync.ts";
import type { ToolContext } from "../../server/mcp/tools/types.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-leads");
const AIRTABLE = "https://airtable.test";
const TOKEN = "airtable-test-token";

let server: LocalServer;
let url: string;
let platformUrl: string;
let pool: pg.Pool;
let platform: pg.Pool;
let storage: LocalStorageDriver;
let airtableFails = false;
const airtableCalls: string[] = [];
let known: { id: number; email: string };

// Two pages of contacts (pagination), one contractor intake, one archived record.
const AIRTABLE_DATA: Record<string, Array<Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>>> = {
  tblcCFpiLhaWcmgMz: [
    [
      { id: "recContact000001", createdTime: "2026-10-24T21:47:35.000Z", fields: { email: "dana.newlead@example.com", name: "dana newlead", phone: "(615) 555-0101", stage: "Schedule Intake Call", status: "No", why: "Second story for twins", financed: "Yes" } },
      { id: "recContact000002", createdTime: "2026-10-23T10:00:00.000Z", fields: { email: "ben+test@anotherstory.com", name: "Ben smoke", stage: "Schedule Intake Call" } },
    ],
    [{ id: "recContact000003", createdTime: "2026-10-22T10:00:00.000Z", fields: { email: "KNOWN_EMAIL", name: "Someone Known", phone: "+1 615 555 0199", stage: "Schedule Intake Call" } }],
  ],
  tblNuWTLJdDorHW6Q: [[{ id: "recIntake0000001", createdTime: "2026-10-25T17:25:02.000Z", fields: { email: "matt@builder.example", name: "Matt Builder", stage: "Schedule Intake Call", geos: "Boise" } }]],
  tblIE6xAPvvxWV89L: [[{ id: "recArchived00001", createdTime: "2025-03-01T10:00:00.000Z", fields: { email: "old.lead@example.com", name: "Old Lead", stage: "Lost" } }]],
};

const airtableFetch: typeof fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  airtableCalls.push(u.pathname + u.search);
  const auth = new Headers(init?.headers).get("authorization");
  if (u.origin !== AIRTABLE) return new Response("no route", { status: 404 });
  if (airtableFails || auth !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ error: { type: "AUTHENTICATION_REQUIRED" } }), { status: 401 });
  const table = u.pathname.split("/")[3];
  const pages = AIRTABLE_DATA[table] ?? [[]];
  const at = Number(u.searchParams.get("offset") ?? 0);
  const records = pages[at].map((r) => ({ ...r, fields: Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v === "KNOWN_EMAIL" ? known.email.toUpperCase() : v])) }));
  return new Response(JSON.stringify({ records, ...(at + 1 < pages.length ? { offset: String(at + 1) } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
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
    LEADS_DATABASE_URL: platformUrl,
    AIRTABLE_TOKEN: TOKEN,
    AIRTABLE_API_URL: AIRTABLE,
    ...overrides,
  });
}

function makeCtx(config: Config): WorkerContext {
  return {
    config,
    pool,
    storage,
    fetchImpl: airtableFetch,
    sleep: async () => {},
    now: () => new Date(),
    log: () => {},
    tmpDir: os.tmpdir(),
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    deadline: Date.now() + 60_000,
    bytesBudget: 1e12,
  };
}

function toolCtx(ids: string[]): ToolContext {
  return {
    reader: pool,
    proposer: pool,
    scope: { ids, all: false, unassigned: false, stored: ids },
    principal: { label: "test", tokenId: null } as unknown as ToolContext["principal"],
    publicUrl: "https://vault.test",
    embeddings: null,
    now: () => new Date("2026-10-26T12:00:00Z"),
  };
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0] as T;
}

beforeAll(async () => {
  server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  ({ url } = await resetDatabase(server, "strout_vault_leads", { seed: true, storageDir: STORAGE, quiet: true }));
  pool = new pg.Pool({ connectionString: url, max: 4 });
  storage = new LocalStorageDriver({ rootDir: STORAGE, secret: "test-secret-test-secret-test-secret" });

  // A stand-in for AnotherStoryBLDR's database: just the two tables and the columns the vault reads.
  const admin = new pg.Client({ connectionString: server.adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists strout_vault_platform_stub`);
  await admin.query(`create database strout_vault_platform_stub`);
  await admin.end();
  platformUrl = server.adminUrl.replace(/\/[^/?]*(\?|$)/, "/strout_vault_platform_stub$1");
  platform = new pg.Pool({ connectionString: platformUrl, max: 2 });
  await platform.query(`
    create table leads (id text primary key, email text, name text, phone text, company text, zip text, market_slug text, market_zip text, kind text, source text,
      source_ref text, lead_type text, status text, recruit_stage text, recruit_warm boolean, notes text, intent text, query text, territory_id text,
      agent_owner text, created_at timestamptz, last_touched_at timestamptz, recruit_stage_at timestamptz);
    create table site_leads (id text primary key, email text, host text, address text, zip text, status text, coverage text, source text,
      matched_territory_slug text, territory_id text, in_market boolean, chosen_style text, report_sent_at timestamptz, call_booked_at timestamptz, created_at timestamptz);
    insert into leads values
      ('L1', 'pat.contractor@example.com', 'Pat Contractor', '615-555-0123', 'Pat Builds LLC', '37203', 'nashville', null, 'contractor_gate', 'platform', null, 'contractor', 'new', 'sourced', true, null, null, null, null, null, now() - interval '2 days', null, null),
      ('L2', 'dana.newlead@example.com', null, null, null, '37211', 'nashville', null, 'site_lead', 'platform', null, 'homeowner', 'new', null, null, null, null, null, null, null, now() - interval '3 days', null, null),
      ('L3', 'gone@example.com', 'Gone Lead', null, null, null, null, null, 'backfill_airtable', 'airtable', 'recX', 'homeowner', 'dead', null, null, 'not interested', null, null, null, null, '2026-05-01', null, null),
      ('L4', 'qa+smoke@example.com', 'Smoke', null, null, null, null, null, 'contractor_gate', 'platform', null, 'contractor', 'dead', null, null, null, null, null, null, null, now(), null, null),
      ('L5', null, 'No Contact', null, null, null, null, null, 'backfill_tiktok', 'tiktok', null, 'contractor', 'new', null, null, null, null, null, null, null, now(), null, null);
    insert into site_leads values
      ('S1', 'Dana.Newlead@example.com', 'anotherstorynash.com', '12 Maple St, Nashville, TN', '37211', 'reported', 'in_market', null, 'nashville-south', null, true, 'craftsman', now() - interval '1 day', null, now() - interval '1 day');
  `);

  known = await one(`select id, emails[1] as email from parties where cardinality(emails) > 0 order by id limit 1`);
  // A recording whose title names the new lead: the sync should propose tagging her on it.
  await pool.query(`insert into interactions (workspace_id, kind, occurred_at, title) values ('another_story', 'meeting', now() - interval '6 hours', 'Dana Newlead: AnotherStory Assessment')`);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await platform?.end();
});

describe("leads sync", () => {
  it("is off without a source", async () => {
    const r = await runWorker(makeCtx(makeConfig({ LEADS_DATABASE_URL: "", AIRTABLE_TOKEN: "" })), { trigger: "test", steps: ["leads"] });
    expect(formatRunSummary(r.summary)).toBe("leads: off (no source configured)");
  });

  it("dry run counts everything and writes nothing", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["leads"], dryRun: true });
    const l = r.summary.leads!;
    expect(l).toMatchObject({ dryRun: true, skippedInternal: 2, skippedNoContact: 1, leads: 8, newLeads: 8 });
    expect(l.sources).toMatchObject({ platform: { configured: true, read: 6 }, airtable: { configured: true, read: 5 } });
    // Dana appears three times (platform lead, funnel, Airtable): one new party, not three.
    expect(l.partiesCreated).toBe(5);
    expect(l.partiesMatched).toBe(3);
    expect((await one<{ n: number }>(`select count(*)::int as n from lead_records`)).n).toBe(0);
    expect(formatRunSummary(r.summary)).toMatch(/\(dry run, nothing written\)/);
  });

  it("mirrors every lead, resolves people across sources and queues the call link", async () => {
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["leads"] });
    const l = r.summary.leads!;
    expect(l.errors).toEqual([]);
    expect(l).toMatchObject({ leads: 8, newLeads: 8, partiesCreated: 5, partiesMatched: 3, callLinksQueued: 1 });
    expect(airtableCalls.some((c) => c.includes("offset=1"))).toBe(true); // followed the second page

    const byOrigin = (await pool.query(`select origin, count(*)::int as n from lead_records group by 1 order by 1`)).rows;
    expect(byOrigin).toEqual([
      { origin: "airtable_archived", n: 1 },
      { origin: "airtable_contact", n: 2 },
      { origin: "airtable_contractor_intake", n: 1 },
      { origin: "platform_leads", n: 3 },
      { origin: "platform_site_leads", n: 1 },
    ]);
    // Dana: one party, three records, the name from Airtable (title-cased), phone and address learned.
    const dana = await one(`select p.id, p.name, p.phones, p.location from parties p where 'dana.newlead@example.com' = any(p.emails)`);
    expect(dana.name).toBe("Dana Newlead");
    expect(dana.phones).toEqual(["(615) 555-0101"]);
    expect(dana.location).toBe("12 Maple St, Nashville, TN");
    expect((await one<{ n: number }>(`select count(*)::int as n from lead_records where party_id = $1`, [dana.id])).n).toBe(3);
    expect(await one(`select role, status, detail from roles where party_id = $1 and workspace_id = 'another_story'`, [dana.id])).toEqual({ role: "prospect", status: "prospect", detail: "homeowner lead" });

    // A party already in the vault is matched by email (case-insensitive) and learns the phone.
    const rec = await one(`select party_id from lead_records where origin_id = 'recContact000003'`);
    expect(Number(rec.party_id)).toBe(Number(known.id));
    const knownParty = await one<{ phones: string[] }>(`select phones from parties where id = $1`, [known.id]);
    expect(knownParty.phones.map(normalizePhone)).toContain("6155550199");

    // Internal traffic never lands; Airtable extras go to details.
    expect((await one<{ n: number }>(`select count(*)::int as n from lead_records where email ilike '%smoke%' or email ilike '%+test%'`)).n).toBe(0);
    expect((await one(`select details from lead_records where origin_id = 'recContact000001'`)).details).toEqual({ why: "Second story for twins", financed: "Yes" });

    // The recording titled with her name gets one proposal.
    const link = await one(`select item_type, proposal, reason from review_queue where proposal->>'source' = 'leads'`);
    expect(link.item_type).toBe("link_party_interaction");
    expect(Number((link.proposal as Record<string, unknown>).party_id)).toBe(Number(dana.id));
  });

  it("re-syncing updates in place: no duplicates, no repeat proposals", async () => {
    await platform.query(`update leads set status = 'contacted' where id = 'L1'`);
    const before = (await one<{ n: number }>(`select count(*)::int as n from parties`)).n;
    const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["leads"] });
    expect(r.summary.leads).toMatchObject({ leads: 8, newLeads: 0, partiesCreated: 0, partiesMatched: 0, callLinksQueued: 0 });
    expect((await one<{ n: number }>(`select count(*)::int as n from parties`)).n).toBe(before);
    expect((await one(`select status from lead_records where origin = 'platform_leads' and origin_id = 'L1'`)).status).toBe("contacted");
  });

  it("a source that fails is reported and the other still syncs", async () => {
    airtableFails = true;
    try {
      await platform.query(`insert into leads (id, email, name, lead_type, status, kind, source, created_at) values ('L6', 'fresh@example.com', 'Fresh Lead', 'homeowner', 'new', 'consult_form', 'platform', now())`);
      const r = await runWorker(makeCtx(makeConfig()), { trigger: "test", steps: ["leads"] });
      expect(r.summary.leads!.sources.airtable.error).toMatch(/HTTP 401/);
      expect(r.summary.leads!.newLeads).toBe(1);
      // Nothing from Airtable was deleted because the source was down.
      expect((await one<{ n: number }>(`select count(*)::int as n from lead_records where origin like 'airtable%'`)).n).toBe(4);
      expect(formatRunSummary(r.summary)).toMatch(/airtable FAILED/);
    } finally {
      airtableFails = false;
    }
  });
});

describe("reading leads", () => {
  it("list_leads gives one entry per person with every submission, and finds who needs a call", async () => {
    const all = await listLeads.run({ workspace: undefined, lead_type: undefined, since: undefined, needs_follow_up: undefined, query: undefined, limit: undefined }, toolCtx(["another_story"]));
    const items = all.result.items as Array<Record<string, unknown>>;
    const dana = items.find((i) => i.name === "Dana Newlead")!;
    expect(dana).toMatchObject({ lead_type: "homeowner", talked_since_latest_submission: false, last_conversation: null });
    expect((dana.submissions as unknown[]).length).toBe(3);
    expect(dana.deep_link).toMatch(/^https:\/\/vault\.test\/p\/\d+$/);

    const follow = await listLeads.run({ workspace: undefined, lead_type: undefined, since: undefined, needs_follow_up: true, query: undefined, limit: 50 }, toolCtx(["another_story"]));
    const names = (follow.result.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).toContain("Dana Newlead");
    expect(names).not.toContain("Gone Lead"); // dead
    expect(names).not.toContain("Old Lead"); // archived

    const contractors = await listLeads.run({ workspace: undefined, lead_type: "contractor", since: undefined, needs_follow_up: undefined, query: "pat", limit: undefined }, toolCtx(["another_story"]));
    expect((contractors.result.items as Array<{ name: string }>).map((i) => i.name)).toEqual(["Pat Contractor"]);

    // Out of scope: nothing.
    const none = await listLeads.run({ workspace: undefined, lead_type: undefined, since: undefined, needs_follow_up: undefined, query: undefined, limit: undefined }, toolCtx(["strout_arch"]));
    expect(none.count).toBe(0);
  });

  it("list_leads pages back with until: every person exactly once, newest first", async () => {
    const args = { workspace: undefined, lead_type: undefined, since: undefined, needs_follow_up: undefined, query: undefined };
    const everyone = (await listLeads.run({ ...args, until: undefined, limit: 50 }, toolCtx(["another_story"]))).result.items as Array<{ party_id: number; latest_submission: string | null }>;
    expect(everyone.length).toBeGreaterThan(2);
    const seen: number[] = [];
    let until: string | undefined;
    for (let guard = 0; guard < everyone.length + 2; guard++) {
      const page = (await listLeads.run({ ...args, until, limit: 1 }, toolCtx(["another_story"]))).result.items as Array<{ party_id: number; latest_submission: string | null }>;
      if (!page.length || !page[0].latest_submission) break;
      if (until) expect(new Date(page[0].latest_submission).getTime()).toBeLessThan(new Date(until).getTime());
      seen.push(page[0].party_id);
      until = page[0].latest_submission;
    }
    const dated = everyone.filter((i) => i.latest_submission).map((i) => i.party_id);
    expect(seen).toEqual(dated);
    await expect(listLeads.run({ ...args, until: "not a date", limit: 1 }, toolCtx(["another_story"]))).rejects.toThrow(/until must be/);
  });

  it("approving the call link takes the lead off the follow-up list", async () => {
    const item = await one<{ id: number }>(`select id from review_queue where proposal->>'source' = 'leads'`);
    const { decideReview } = await import("../../server/services/review.ts");
    await decideReview(pool, item.id, "approve");
    const page = await listLeadPeople(pool, { followUp: true });
    expect(page.items.map((i) => i.name)).not.toContain("Dana Newlead");
    const full = await listLeadPeople(pool, {});
    const dana = full.items.find((i) => i.name === "Dana Newlead")!;
    expect(dana).toMatchObject({ talkedSince: true, submissions: 3, leadType: "homeowner", stage: "report sent" });
    expect(dana.lastConversation?.title).toBe("Dana Newlead: AnotherStory Assessment");
    expect(full.counts.total).toBe(full.items.length);
  });

  it("get_party shows the lead submissions", async () => {
    const r = await getParty.run({ name: "Dana Newlead", id: undefined, email: undefined, phone: undefined }, toolCtx(["another_story"]));
    const leads = r.result.leads as Array<Record<string, unknown>>;
    expect(leads.map((l) => l.origin).sort()).toEqual(["airtable_contact", "platform_leads", "platform_site_leads"]);
  });
});
