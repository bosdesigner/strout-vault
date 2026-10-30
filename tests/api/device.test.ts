// The device ingest (/api/ingest/device/*) on its own local database: token checks (no token,
// the wrong collector's token, an MCP token), presign -> PUT -> finalize, the same file twice
// (by source_ref and by sha256 across the Mac collector and the Shortcut), call recordings matched
// to parties and routed, Apple Notes upsert/edit/unchanged, redaction, import_runs per batch, and
// the phalanx guard: no device source reaches phalanx without a human, even from an explicit rule.
// Nothing here reaches R2, Neon or a paid API.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "../../scripts/lib/localdb.ts";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";
import { noAutoPhalanx, noteParagraphs } from "../../server/device/ingest.ts";
import { parseTokenScopes } from "../../server/mcp/auth/tokens.ts";

const STORAGE = path.join(REPO_ROOT, ".data/storage-device");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-device-"));
const CARD = "4111 1111 1111 1111";

let t: TestApp;
let pool: pg.Pool;
let owner: Session;
const tokens: Record<string, string> = {};
const csrf = () => ({ "x-csrf-token": owner.csrf });

function tone(name: string, freq: number, seconds = 2): { file: string; bytes: Buffer; sha: string } {
  const file = path.join(tmp, name);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-c:a", "aac", file]);
  const bytes = fs.readFileSync(file);
  return { file, bytes, sha: crypto.createHash("sha256").update(bytes).digest("hex") };
}

const auth = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });

/** What the collector and the Shortcut do: presign, PUT every part, finalize. */
async function send(who: string, f: { bytes: Buffer; sha: string }, meta: Record<string, unknown>) {
  const pre = await request(t.app)
    .post("/api/ingest/device/presign")
    .set(auth(who))
    .send({ source: meta.source, source_ref: meta.source_ref, sha256: f.sha, bytes: f.bytes.length, content_type: "audio/mp4", filename: meta.filename ?? "rec.m4a" });
  if (pre.body.duplicate) return { presign: pre, finalize: null };
  expect(pre.status, pre.text).toBe(200);
  for (const p of pre.body.parts) {
    const u = new URL(p.url);
    const start = (p.part_number - 1) * pre.body.part_size;
    const put = await request(t.app).put(u.pathname + u.search).set("content-type", "application/octet-stream").send(f.bytes.subarray(start, start + pre.body.part_size));
    expect(put.status, put.text).toBe(200);
  }
  const fin = await request(t.app)
    .post("/api/ingest/device/finalize")
    .set(auth(who))
    .send({ sha256: f.sha, bytes: f.bytes.length, key: pre.body.key, upload_id: pre.body.upload_id, filename: meta.filename ?? "rec.m4a", content_type: "audio/mp4", occurred_at: "2026-10-21T15:04:05Z", ...meta });
  return { presign: pre, finalize: fin };
}

beforeAll(async () => {
  const server = await ensureLocalServer();
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const urls = await resetDatabase(server, "strout_vault_device", { seed: true, storageDir: STORAGE, quiet: true });
  pool = new pg.Pool({ connectionString: urls.url, max: 4 });
  await pool.query(`update parties set phones = array['214-555-0166'] where id = 6`); // Daniel: phalanx only
  const configDir = path.join(tmp, "config");
  fs.mkdirSync(configDir);
  // Explicit, named rules that point at phalanx: even these never file a device item there.
  fs.writeFileSync(path.join(configDir, "message_routing.yml"), `parties:\n  6: phalanx\napple_notes_folders:\n  Phalanx: phalanx\n  Another Story: another_story\n`);
  t = await buildTestApp({
    DATABASE_URL: urls.url,
    LOCAL_STORAGE_DIR: STORAGE,
    PUBLIC_URL: "http://vault.test",
    MCP_READER_DATABASE_URL: urls.readerUrl,
    MCP_PROPOSER_DATABASE_URL: urls.proposerUrl,
    LOGIN_RATE_LIMIT_MAX: "200",
    OWNER_PHONES: "+1 713 555 0100",
    OWNER_EMAILS: "ben@example.com",
    MESSAGES_CONFIG_DIR: configDir,
  });
  owner = await login(t.app);
  const mint = async (key: string, body: Record<string, unknown>) => {
    const r = await owner.agent.post("/api/mcp/tokens").set(csrf()).send(body);
    expect(r.status, r.text).toBe(201);
    tokens[key] = r.body.token;
    return r.body.item;
  };
  const mac = await mint("mac", { name: "Mac media collector", workspaceScope: ["*"], scopes: ["ingest:device"], purpose: "mac_media" });
  expect(mac.workspaceScope).toEqual([]);
  expect(mac.purpose).toBe("mac_media");
  const sc = await mint("shortcut", { name: "iPhone Shortcut", workspaceScope: [], scopes: ["ingest:device"], purpose: "ios_shortcut" });
  expect(sc.purpose).toBe("ios_shortcut");
  await mint("messages", { name: "iMessage", workspaceScope: [], scopes: ["ingest:messages"] });
  await mint("read", { name: "reader", workspaceScope: ["*"], scopes: ["vault:read"] });
});

afterAll(async () => {
  await pool?.end();
  await t?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ingest:device tokens", () => {
  it("cannot be combined with other scopes, and its purpose must fit", async () => {
    expect(() => parseTokenScopes(["ingest:device", "vault:read"])).toThrow(/cannot be combined/);
    const bad = await owner.agent.post("/api/mcp/tokens").set(csrf()).send({ name: "x", workspaceScope: [], scopes: ["ingest:device"], purpose: "imessage" });
    expect(bad.status).toBe(400);
  });

  it("no token is 401, a bad token 401, another scope 403", async () => {
    const body = { source: "voice_memo", source_ref: "voice_memo:x", sha256: "a".repeat(64), bytes: 10, filename: "a.m4a" };
    expect((await request(t.app).post("/api/ingest/device/presign").send(body)).status).toBe(401);
    expect((await request(t.app).post("/api/ingest/device/presign").set("authorization", "Bearer svt_nope").send(body)).status).toBe(401);
    for (const who of ["messages", "read"]) {
      const r = await request(t.app).post("/api/ingest/device/presign").set(auth(who)).send(body);
      expect(r.status, who).toBe(403);
      expect(r.body.error).toBe("insufficient_scope");
    }
    // ...and a device token cannot send texts or call MCP tools.
    expect((await request(t.app).post("/api/ingest/messages").set(auth("mac")).send({ messages: [] })).status).toBe(403);
    const mcp = await request(t.app).post("/mcp").set(auth("mac")).set("accept", "application/json, text/event-stream").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mcp.status).toBe(401);
  });

  it("rejects malformed requests without echoing values", async () => {
    const r = await request(t.app).post("/api/ingest/device/presign").set(auth("mac")).send({ source: "voice_memo", source_ref: "has space", sha256: "zz", bytes: -1, filename: "secret-name.m4a" });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("secret-name");
    const wrongType = await request(t.app).post("/api/ingest/device/presign").set(auth("mac")).send({ source: "voice_memo", source_ref: "voice_memo:pdf", sha256: "b".repeat(64), bytes: 10, filename: "a.pdf" });
    expect(wrongType.status).toBe(415);
  });
});

describe("presign -> PUT -> finalize", () => {
  it("files a voice memo: interactions, media, jobs, inbox (nobody on it, no review row)", async () => {
    const memo = tone("memo.m4a", 440);
    const run = await request(t.app).post("/api/ingest/device/runs").set(auth("mac")).send({ collector: { name: "apple-media", version: "test" } });
    expect(run.status).toBe(201);
    const { presign, finalize } = await send("mac", memo, { source: "voice_memo", source_ref: "voice_memo:AAAA-1111", title: "Porch idea", duration_sec: 2, run_id: run.body.run_id, filename: "20261021 150405.m4a" });
    expect(presign.body.key).toMatch(/^uploads\/device\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/20261021 150405\.m4a$/);
    expect(presign.body.parts).toHaveLength(1);
    expect(finalize!.status, finalize!.text).toBe(201);
    expect(finalize!.body).toMatchObject({ duplicate: false, workspace_id: "inbox", review_queued: false });
    const i = (await pool.query(`select * from interactions where id = $1`, [finalize!.body.interaction_id])).rows[0];
    expect(i).toMatchObject({ kind: "recording", source: "voice_memo", source_ref: "voice_memo:AAAA-1111", title: "Porch idea", pipeline_status: "queued", workspace_id: "inbox" });
    expect(i.source_payload.via).toBe("mac_collector");
    const m = (await pool.query(`select * from media where interaction_id = $1`, [i.id])).rows[0];
    expect(m).toMatchObject({ source: "voice_memo", role: "original", status: "verified", kind: "audio", sha256: memo.sha, bytes: memo.bytes.length });
    expect(fs.readFileSync(path.join(STORAGE, m.storage_key)).equals(memo.bytes)).toBe(true);
    const jobs = (await pool.query(`select stage, status from jobs where media_id = $1 order by stage`, [m.id])).rows;
    expect(jobs).toEqual([{ stage: "transcribe", status: "pending" }]); // no extract job: extraction is tracked on the interaction
    const fin = await request(t.app).post(`/api/ingest/device/runs/${run.body.run_id}/finish`).set(auth("mac")).send({ counts_in: { scanned: { voice_memo: 1 } } });
    expect(fin.status).toBe(200);
    const ir = (await pool.query(`select * from import_runs where id = $1`, [run.body.run_id])).rows[0];
    expect(ir).toMatchObject({ source: "apple_media", ok: true });
    expect(ir.counts_out).toEqual({ created: { voice_memo: 1 } });
    expect(ir.counts_in.scanned).toEqual({ voice_memo: 1 });
    // The run cannot be finished twice, nor by another token.
    expect((await request(t.app).post(`/api/ingest/device/runs/${run.body.run_id}/finish`).set(auth("mac")).send({})).status).toBe(404);
  });

  it("the same file twice is one row: by source_ref, and by sha256 from the Shortcut", async () => {
    const memo = tone("memo2.m4a", 523);
    const first = await send("mac", memo, { source: "voice_memo", source_ref: "voice_memo:BBBB-2222" });
    expect(first.finalize!.status).toBe(201);
    const id = first.finalize!.body.interaction_id;
    const again = await send("mac", memo, { source: "voice_memo", source_ref: "voice_memo:BBBB-2222" });
    expect(again.presign.status).toBe(200);
    expect(again.presign.body).toEqual({ duplicate: true, interaction_id: id });
    const fromPhone = await send("shortcut", memo, { source: "voice_memo", source_ref: `shortcut:${memo.sha}` });
    expect(fromPhone.presign.body).toEqual({ duplicate: true, interaction_id: id });
    // A finalize that slipped past presign (two sends racing) is answered as a duplicate too.
    const late = await request(t.app).post("/api/ingest/device/finalize").set(auth("shortcut")).send({
      source: "voice_memo", source_ref: `shortcut:${memo.sha}`, sha256: memo.sha, bytes: memo.bytes.length, key: first.presign.body.key, upload_id: "0".repeat(32), filename: "x.m4a", occurred_at: "2026-10-21T15:04:05Z",
    });
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ duplicate: true, interaction_id: id });
    const n = (await pool.query(`select count(*)::int as n from media where sha256 = $1`, [memo.sha])).rows[0].n;
    expect(n).toBe(1);
    // Every Shortcut send is its own one-item batch.
    const sc = (await pool.query(`select counts_out from import_runs where source = 'ios_shortcut' order by id desc limit 1`)).rows[0];
    expect(sc.counts_out).toEqual({ duplicate: { voice_memo: 1 } });
  });

  it("matches a call recording's counterparty by phone and files it (Kevin: another_story)", async () => {
    const call = tone("call.m4a", 660);
    const { finalize } = await send("mac", call, {
      source: "iphone_call",
      source_ref: "notes:NOTE-1:ATT-1",
      participants_raw: [{ name: "Kevin", phone: "(936) 555-0142" }],
      source_payload: { apple_transcript: `Kevin said the card is ${CARD}`, note_id: "NOTE-1" },
      duration_sec: 2,
    });
    expect(finalize!.status, finalize!.text).toBe(201);
    expect(finalize!.body.workspace_id).toBe("another_story");
    const i = (await pool.query(`select * from interactions where id = $1`, [finalize!.body.interaction_id])).rows[0];
    expect(i.kind).toBe("call");
    expect(i.title).toMatch(/^Call with Kevin McGuire · 2026-10-21$/);
    expect(i.participants_raw).toEqual([{ identifier: "+19365550142", kind: "phone", name: "Kevin", party_id: 2 }]);
    expect(i.source_payload.apple_transcript).toContain("[REDACTED]");
    expect(JSON.stringify(i.source_payload)).not.toContain("4111");
    const p = (await pool.query(`select party_id from interaction_participants where interaction_id = $1`, [i.id])).rows;
    expect(p.map((r) => Number(r.party_id))).toEqual([2]);
  });

  it("a name alone matches only when exactly one person has it", async () => {
    const call = tone("call-name.m4a", 700);
    const { finalize } = await send("shortcut", call, { source: "iphone_call", source_ref: "shortcut:name-only", participants_raw: [{ name: "Kevin McGuire" }] });
    expect(finalize!.body.workspace_id).toBe("another_story");
    const i = (await pool.query(`select source_payload from interactions where id = $1`, [finalize!.body.interaction_id])).rows[0];
    expect(i.source_payload.via).toBe("ios_shortcut");
  });
});

describe("phalanx is never assigned to a device item", () => {
  it("a call whose only party maps to phalanx (by role and by an explicit rule) goes to inbox with a review row", async () => {
    const call = tone("call-daniel.m4a", 800);
    const { finalize } = await send("mac", call, { source: "iphone_call", source_ref: "notes:NOTE-2:ATT-2", participants_raw: [{ name: "Daniel", phone: "214-555-0166" }] });
    expect(finalize!.body).toMatchObject({ workspace_id: "inbox", review_queued: true });
    const rq = (await pool.query(`select * from review_queue where interaction_id = $1`, [finalize!.body.interaction_id])).rows[0];
    expect(rq).toMatchObject({ item_type: "workspace_assignment", status: "open" });
    expect(rq.proposal.workspace_id).toBe("phalanx");
  });

  it("a note in a folder whose rule says phalanx goes to inbox with phalanx suggested", async () => {
    const r = await request(t.app).post("/api/ingest/device/note").set(auth("mac")).send({ source: "apple_note", source_ref: "apple_note:P-1", occurred_at: "2026-10-20T10:00:00Z", title: "Pilot pricing", folder: "Phalanx", text: "Pilot pricing thoughts.\n\nThree sites, ninety days." });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "created", workspace_id: "inbox", review_queued: true });
  });

  it("the guard itself: whatever routing returns, phalanx becomes inbox", () => {
    expect(noAutoPhalanx({ workspaceId: "phalanx", review: null })).toMatchObject({ workspaceId: "inbox", review: { suggested: "phalanx" } });
    expect(noAutoPhalanx({ workspaceId: "another_story", review: null }).workspaceId).toBe("another_story");
  });

  it("no device interaction anywhere in the database is in phalanx", async () => {
    const n = (await pool.query(`select count(*)::int as n from interactions where source in ('voice_memo', 'iphone_call', 'apple_note') and workspace_id = 'phalanx'`)).rows[0].n;
    expect(n).toBe(0);
  });
});

describe("Apple Notes", () => {
  it("creates, leaves an unchanged note alone, and updates an edited one in place (re-queued for embedding)", async () => {
    const note = { source: "apple_note", source_ref: "apple_note:N-1", occurred_at: "2026-10-19T09:00:00Z", modified_at: "2026-10-19T09:00:00Z", title: "Shutter order", folder: "Another Story", text: `Cedar for the Woodlands porch.\n\nPay with ${CARD}.` };
    const a = await request(t.app).post("/api/ingest/device/note").set(auth("mac")).send(note);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: "created", workspace_id: "another_story" });
    const id = a.body.interaction_id;
    const row = (await pool.query(`select * from interactions where id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ kind: "note", source: "apple_note", pipeline_status: "ready", media_id: null });
    expect(row.transcript).toContain("[REDACTED]");
    expect(row.transcript).not.toContain("4111");
    const segs = (await pool.query(`select idx, text from segments where interaction_id = $1 order by idx`, [id])).rows;
    expect(segs.map((s) => s.text)).toEqual(["Cedar for the Woodlands porch.", "Pay with [REDACTED]."]);
    await pool.query(`update interactions set embedded_at = now() + interval '1 minute', embed_attempts = 2 where id = $1`, [id]);

    const same = await request(t.app).post("/api/ingest/device/note").set(auth("mac")).send(note);
    expect(same.body).toMatchObject({ status: "unchanged", interaction_id: id });

    const edited = await request(t.app).post("/api/ingest/device/note").set(auth("mac")).send({ ...note, folder: "Phalanx", modified_at: "2026-10-22T09:00:00Z", text: "Cedar for the Woodlands porch.\n\nOrder placed Tuesday." });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ status: "updated", interaction_id: id, workspace_id: "another_story" });
    const after = (await pool.query(`select * from interactions where id = $1`, [id])).rows[0];
    expect(after.embed_attempts).toBe(0);
    expect(new Date(after.pipeline_updated_at).getTime()).toBeGreaterThan(new Date(row.pipeline_updated_at).getTime());
    expect((await pool.query(`select count(*)::int as n from interactions where source_ref = 'apple_note:N-1'`)).rows[0].n).toBe(1);
    expect((await pool.query(`select text from segments where interaction_id = $1 order by idx`, [id])).rows.map((s) => s.text)).toEqual(["Cedar for the Woodlands porch.", "Order placed Tuesday."]);
  });

  it("an empty note writes nothing", async () => {
    const r = await request(t.app).post("/api/ingest/device/note").set(auth("mac")).send({ source: "apple_note", source_ref: "apple_note:EMPTY", occurred_at: "2026-10-19T09:00:00Z", text: "  ￼ " });
    expect(r.body.status).toBe("empty");
  });

  it("paragraph splitting", () => {
    expect(noteParagraphs("a\n\nb\n- one\n- two")).toEqual(["a", "b", "- one", "- two"]);
    expect(noteParagraphs("x".repeat(4500)).every((p) => p.length <= 2001)).toBe(true);
  });
});

describe("nothing secret in any table", () => {
  it("the fixture card number is nowhere", async () => {
    const { rows } = await pool.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    for (const r of rows) {
      const { rows: data } = await pool.query(`select t::text as row from "${r.table_name}" t`);
      const all = data.map((d) => d.row).join("\n");
      expect(all.includes("4111 1111") || all.includes("4111111111111111"), r.table_name).toBe(false);
    }
  });
});
