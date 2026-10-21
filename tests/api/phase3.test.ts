import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, lastMagicToken, login, type Session, type TestApp } from "../helpers.ts";
import { twilioSignature } from "../../server/twilio/signature.ts";
import type { LibraryPage, RecordingDetail } from "../../shared/types.ts";

const TWILIO_SID = "ACtest00000000000000000000000000000";
const TWILIO_TOKEN = "twilio-test-token";
const PUBLIC_URL = "http://vault.test";
const FAKE_MP3 = Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(4096)]);

let fetched: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  fetched.push(url);
  if (url.includes("/Recordings/RE404")) return new Response("not found", { status: 404 });
  expect((init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  return new Response(FAKE_MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
};

let t: TestApp;
let owner: Session;
beforeAll(async () => {
  t = await buildTestApp({ TWILIO_ACCOUNT_SID: TWILIO_SID, TWILIO_AUTH_TOKEN: TWILIO_TOKEN, PUBLIC_URL, LOGIN_RATE_LIMIT_MAX: "100" }, { fetchImpl: fakeFetch });
  owner = await login(t.app);
});
afterAll(() => t.close());

const csrf = (s: Session) => ({ "x-csrf-token": s.csrf });

async function contractorSession(email: string): Promise<Session> {
  await request(t.app).post("/api/auth/magic-link").send({ email });
  const token = lastMagicToken(t.mailer)!;
  const agent = request.agent(t.app);
  const res = await agent.get(`/api/auth/magic?token=${encodeURIComponent(token)}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/");
  const me = await agent.get("/api/auth/me");
  expect(me.status).toBe(200);
  return { agent, csrf: me.body.csrfToken };
}

describe("contractor login with magic links", () => {
  it("sends a single-use link to a known membership and says the same thing for unknown addresses", async () => {
    const before = t.mailer.sent.length;
    const unknown = await request(t.app).post("/api/auth/magic-link").send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(200);
    expect(t.mailer.sent.length).toBe(before); // nothing sent, nothing revealed
    const known = await request(t.app).post("/api/auth/magic-link").send({ email: "Kevin.McGuire@example.com" });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(t.mailer.sent.length).toBe(before + 1);
    const mail = t.mailer.last()!;
    expect(mail.to).toBe("kevin.mcguire@example.com");
    expect(mail.text).toContain(`${PUBLIC_URL}/api/auth/magic?token=`);
    const token = lastMagicToken(t.mailer)!;
    // Only a hash is stored.
    const { rows } = await t.dbHandle.pool.query(`select token_hash, used_at from login_tokens order by id desc limit 1`);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));

    const agent = request.agent(t.app);
    const redeem = await agent.get(`/api/auth/magic?token=${encodeURIComponent(token)}`);
    expect(redeem.status).toBe(302);
    expect(redeem.headers["set-cookie"]?.[0]).toMatch(/^sv_session=.*HttpOnly/i);
    const me = await agent.get("/api/auth/me");
    expect(me.body.user).toMatchObject({ email: "kevin.mcguire@example.com", role: "contractor", workspaceId: "another_story", displayName: "Kevin McGuire" });
    expect(me.body.user.partyId).toBeGreaterThan(0);

    // Second use is refused; a bogus token is refused.
    const again = await request(t.app).get(`/api/auth/magic?token=${encodeURIComponent(token)}`);
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe("/login?error=link");
    expect((await request(t.app).get(`/api/auth/magic?token=nope`)).headers.location).toBe("/login?error=link");
    const used = await t.dbHandle.pool.query(`select used_at from login_tokens where token_hash = $1`, [rows[0].token_hash]);
    expect(used.rows[0].used_at).not.toBeNull();
  });

  it("activates an invited membership on first login and refuses disabled ones", async () => {
    const carlos = await contractorSession("carlos@oakridgebuilders.example.com");
    const { rows } = await t.dbHandle.pool.query(`select status, last_login_at from memberships where email = 'carlos@oakridgebuilders.example.com'`);
    expect(rows[0].status).toBe("active");
    expect(rows[0].last_login_at).not.toBeNull();
    expect((await carlos.agent.get("/api/interactions")).status).toBe(200);

    await owner.agent.patch("/api/memberships/2").set(csrf(owner)).send({ status: "disabled" });
    const before = t.mailer.sent.length;
    await request(t.app).post("/api/auth/magic-link").send({ email: "carlos@oakridgebuilders.example.com" });
    expect(t.mailer.sent.length).toBe(before); // disabled: no link
    await owner.agent.patch("/api/memberships/2").set(csrf(owner)).send({ status: "active" });
  });

  it("rate-limits link requests", async () => {
    const fresh = await buildTestApp({ LOGIN_RATE_LIMIT_MAX: "4" });
    try {
      // LOGIN_RATE_LIMIT_MAX=4 allows 3 link requests per window (half, minimum 3).
      for (let i = 0; i < 3; i++) expect((await request(fresh.app).post("/api/auth/magic-link").set("X-Forwarded-For", "198.51.100.7").send({ email: "x@example.com" })).status).toBe(200);
      expect((await request(fresh.app).post("/api/auth/magic-link").set("X-Forwarded-For", "198.51.100.7").send({ email: "x@example.com" })).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

describe("what a contractor can see", () => {
  let kevin: Session;
  let kevinPartyId: number;
  beforeAll(async () => {
    kevin = await contractorSession("kevin.mcguire@example.com");
    kevinPartyId = (await kevin.agent.get("/api/auth/me")).body.user.partyId;
  });

  it("library, status and search are limited to recordings they took part in or uploaded, in their workspace", async () => {
    const page = (await kevin.agent.get("/api/interactions?limit=100")).body as LibraryPage;
    expect(page.items.length).toBeGreaterThan(0);
    const { rows } = await t.dbHandle.pool.query(
      `select i.id from interactions i where i.workspace_id = 'another_story' and (
         exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = $1)
         or exists (select 1 from media m where m.interaction_id = i.id and m.uploaded_by = $1))`,
      [kevinPartyId],
    );
    expect(page.items.map((i) => i.id).sort()).toEqual(rows.map((r) => r.interaction_id ?? r.id).sort());
    for (const it of page.items) expect(it.workspaceId).toBe("another_story");
    const all = (await owner.agent.get("/api/interactions?limit=100")).body as LibraryPage;
    expect(all.items.length).toBeGreaterThan(page.items.length);

    const hidden = all.items.find((i) => !page.items.some((v) => v.id === i.id))!;
    expect((await kevin.agent.get(`/api/interactions/${hidden.id}`)).status).toBe(404);
    expect((await kevin.agent.get(`/api/interactions/${hidden.id}/segments`)).status).toBe(404);
    expect((await kevin.agent.get(`/api/interactions/${hidden.id}/speakers`)).status).toBe(404);
    expect((await kevin.agent.get(`/api/interactions/status?ids=${hidden.id},${page.items[0].id}`)).body.items.map((x: { id: number }) => x.id)).toEqual([page.items[0].id]);
    expect((await kevin.agent.get(`/api/interactions/${page.items[0].id}`)).status).toBe(200);

    const search = (await kevin.agent.get("/api/search?q=drone")).body;
    const visible = new Set(page.items.map((i) => i.id));
    expect(search.groups.length).toBeGreaterThan(0);
    for (const g of search.groups) expect(visible.has(g.interactionId)).toBe(true);
  });

  it("cannot reach owner-only sections or change data", async () => {
    for (const path of ["/api/review", "/api/projects", "/api/memberships", "/api/tracked-numbers", "/api/calls", "/api/parties/1"]) {
      expect((await kevin.agent.get(path)).status, path).toBe(403);
    }
    const mine = (await kevin.agent.get("/api/interactions?limit=1")).body.items[0];
    expect((await kevin.agent.patch(`/api/interactions/${mine.id}`).set(csrf(kevin)).send({ title: "x" })).status).toBe(403);
    expect((await kevin.agent.post(`/api/interactions/${mine.id}/participants`).set(csrf(kevin)).send({ partyId: 1 })).status).toBe(403);
    expect((await kevin.agent.patch(`/api/clips/1`).set(csrf(kevin)).send({ status: "approved" })).status).toBe(403);
    expect((await kevin.agent.patch(`/api/parties/${kevinPartyId}`).set(csrf(kevin)).send({ name: "x" })).status).toBe(403);
    // People list is allowed for tagging their uploads, but only their workspace and without contact details.
    const people = (await kevin.agent.get("/api/parties")).body.items as Array<{ name: string; emails: string[]; roles: Array<{ workspaceId: string }> }>;
    expect(people.map((p) => p.name).sort()).toEqual(["Ben Strout", "Kevin McGuire", "Sam Whitaker"]);
    for (const p of people) expect(p.emails).toEqual([]);
    expect((await kevin.agent.get("/api/parties?workspace=strout_arch")).body.items.map((p: { name: string }) => p.name).sort()).toEqual(["Ben Strout", "Kevin McGuire", "Sam Whitaker"]);
  });

  it("can upload, and the upload lands in their workspace tagged with them so they can see it", async () => {
    const bytes = crypto.randomBytes(5000);
    const create = await kevin.agent.post("/api/uploads/multipart").set(csrf(kevin)).send({ filename: "site-walk.mp4", type: "video/mp4", size: bytes.length });
    expect(create.status).toBe(200);
    const { uploadId, key } = create.body;
    const sign = await kevin.agent.get(`/api/uploads/multipart/${uploadId}/1?key=${encodeURIComponent(key)}`);
    const put = await kevin.agent.put(sign.body.url).set("content-type", "application/octet-stream").send(bytes);
    expect(put.status).toBe(200);
    await kevin.agent.post(`/api/uploads/multipart/${uploadId}/complete?key=${encodeURIComponent(key)}`).set(csrf(kevin)).send({ parts: [{ PartNumber: 1, ETag: put.headers.etag }] });
    const finish = await kevin.agent.post("/api/uploads/finish").set(csrf(kevin)).send({
      key,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mimeType: "video/mp4",
      originalFilename: "site-walk.mp4",
      title: "Site walk",
      recordedAt: "2026-10-10T15:00:00.000Z",
      workspaceId: "strout_arch", // ignored: contractors upload into their own workspace
      source: "contractor_call",
      partyIds: [],
    });
    expect(finish.status).toBe(201);
    const rec = (await kevin.agent.get(`/api/interactions/${finish.body.interactionId}`)).body as RecordingDetail;
    expect(rec.workspace?.id).toBe("another_story");
    expect(rec.participants.map((p) => p.id)).toContain(kevinPartyId);
    const media = await t.dbHandle.pool.query(`select uploaded_by from media where id = $1`, [finish.body.mediaId]);
    expect(media.rows[0].uploaded_by).toBe(kevinPartyId);
  });
});

describe("owner: memberships and tracked numbers", () => {
  it("lists, invites (sending a link), updates and re-sends", async () => {
    const list = await owner.agent.get("/api/memberships");
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: { email: string }) => m.email)).toContain("kevin.mcguire@example.com");
    const before = t.mailer.sent.length;
    const sam = (await owner.agent.get("/api/parties?q=Sam")).body.items[0];
    const invite = await owner.agent.post("/api/memberships").set(csrf(owner)).send({ email: "sam.whitaker@example.com", workspaceId: "another_story", partyId: sam.id, displayName: "Sam Whitaker" });
    expect(invite.status).toBe(201);
    expect(invite.body).toMatchObject({ status: "invited", workspaceName: "Another Story", partyName: "Sam Whitaker" });
    expect(t.mailer.sent.length).toBe(before + 1);
    expect(t.mailer.last()!.to).toBe("sam.whitaker@example.com");
    expect((await owner.agent.post("/api/memberships").set(csrf(owner)).send({ email: "sam.whitaker@example.com", workspaceId: "another_story" })).status).toBe(409);
    expect((await owner.agent.post("/api/memberships").set(csrf(owner)).send({ email: "x@example.com", workspaceId: "nope" })).status).toBe(400);
    const resend = await owner.agent.post(`/api/memberships/${invite.body.id}/send-link`).set(csrf(owner));
    expect(resend.status).toBe(200);
    expect(t.mailer.sent.length).toBe(before + 2);
    const disabled = await owner.agent.patch(`/api/memberships/${invite.body.id}`).set(csrf(owner)).send({ status: "disabled" });
    expect(disabled.body.status).toBe("disabled");
  });

  it("records an already-bought Twilio number and lists calls", async () => {
    const numbers = await owner.agent.get("/api/tracked-numbers");
    expect(numbers.status).toBe(200);
    expect(numbers.body.webhookUrl).toBe(`${PUBLIC_URL}/webhooks/twilio/voice`);
    expect(numbers.body.twilioConfigured).toBe(true);
    expect(numbers.body.items[0]).toMatchObject({ phoneNumber: "+19365550199", partyName: "Kevin McGuire", callCount: 2 });
    const sam = (await owner.agent.get("/api/parties?q=Sam")).body.items[0];
    const added = await owner.agent.post("/api/tracked-numbers").set(csrf(owner)).send({ phoneNumber: "(512) 555-0177", forwardTo: "512-555-0121", workspaceId: "another_story", partyId: sam.id, recordingNotice: "Recorded for notes." });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ phoneNumber: "+15125550177", forwardTo: "+15125550121", status: "active" });
    expect((await owner.agent.post("/api/tracked-numbers").set(csrf(owner)).send({ phoneNumber: "+15125550177", forwardTo: "+15125550121", workspaceId: "another_story", partyId: sam.id })).status).toBe(409);
    const paused = await owner.agent.patch(`/api/tracked-numbers/${added.body.id}`).set(csrf(owner)).send({ status: "paused" });
    expect(paused.body.status).toBe("paused");
    const calls = await owner.agent.get("/api/calls");
    expect(calls.body.items.length).toBeGreaterThanOrEqual(2);
    expect(calls.body.items.some((c: { caller: { name: string } | null }) => c.caller?.name === "Tom Ashworth")).toBe(true);
  });
});

describe("twilio webhooks", () => {
  const voiceUrl = `${PUBLIC_URL}/webhooks/twilio/voice`;
  const post = (pathname: string, params: Record<string, string>, sig?: string) =>
    request(t.app)
      .post(pathname)
      .type("form")
      .set("X-Twilio-Signature", sig ?? twilioSignature(TWILIO_TOKEN, `${PUBLIC_URL}${pathname}`, params))
      .send(params);

  it("refuses requests without a valid signature and when Twilio is not configured", async () => {
    const params = { CallSid: "CAbad", From: "+12815550133", To: "+19365550199" };
    expect((await post("/webhooks/twilio/voice", params, "nope")).status).toBe(403);
    expect((await request(t.app).post("/webhooks/twilio/voice").type("form").send(params)).status).toBe(403);
    const unconfigured = await buildTestApp();
    try {
      expect((await request(unconfigured.app).post("/webhooks/twilio/voice").type("form").send(params)).status).toBe(503);
    } finally {
      await unconfigured.close();
    }
  });

  it("answers an incoming call with the notice and a recorded forward, and records the call", async () => {
    const params = { CallSid: "CAtest0001", From: "(281) 555-0133", To: "+19365550199", CallStatus: "ringing", Direction: "inbound" };
    const res = await post("/webhooks/twilio/voice", params);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toContain("<Say voice=\"Polly.Joanna\">This call is recorded so Another Story can keep good notes.");
    expect(res.text).toContain(`<Dial record="record-from-answer-dual"`);
    expect(res.text).toContain(`recordingStatusCallback="${PUBLIC_URL}/webhooks/twilio/recording"`);
    expect(res.text).toContain("<Number>+19365550142</Number>");
    const { rows } = await t.dbHandle.pool.query(`select c.*, p.name as caller from calls c left join parties p on p.id = c.caller_party_id where call_sid = 'CAtest0001'`);
    expect(rows[0]).toMatchObject({ from_number: "+12815550133", to_number: "+19365550199", status: "ringing", caller: "Tom Ashworth" });

    const unknown = await post("/webhooks/twilio/voice", { CallSid: "CAtest0002", From: "+15555550000", To: "+15550000000" });
    expect(unknown.text).toContain("not in service");
    expect(unknown.text).toContain("<Hangup/>");

    const status = await post("/webhooks/twilio/status", { CallSid: "CAtest0001", DialCallStatus: "completed", DialCallDuration: "321" });
    expect(status.status).toBe(200);
    const after = await t.dbHandle.pool.query(`select status, duration_sec, ended_at from calls where call_sid = 'CAtest0001'`);
    expect(after.rows[0]).toMatchObject({ status: "completed", duration_sec: 321 });
    expect(after.rows[0].ended_at).not.toBeNull();
  });

  it("copies the finished recording into the vault as a contractor_call interaction with media, jobs and participants", async () => {
    fetched = [];
    const before = (await t.dbHandle.pool.query(`select count(*)::int as n from interactions`)).rows[0].n;
    const params = { CallSid: "CAtest0001", RecordingSid: "REtest0001", RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/REtest0001", RecordingStatus: "completed", RecordingDuration: "318" };
    const res = await post("/webhooks/twilio/recording", params);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetched).toEqual(["https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/REtest0001.mp3"]);

    const call = (await t.dbHandle.pool.query(`select * from calls where call_sid = 'CAtest0001'`)).rows[0];
    expect(call.recording_status).toBe("stored");
    expect(call.interaction_id).toBe(res.body.interactionId);
    const rec = (await owner.agent.get(`/api/interactions/${res.body.interactionId}`)).body as RecordingDetail;
    expect(rec).toMatchObject({ source: "contractor_call", kind: "call", pipelineStatus: "queued", title: "Call with Tom Ashworth", durationSec: 318 });
    expect(rec.workspace?.id).toBe("another_story");
    expect(rec.participants.map((p) => p.name).sort()).toEqual(["Kevin McGuire", "Tom Ashworth"]);
    expect(rec.files).toHaveLength(1);
    expect(rec.files[0]).toMatchObject({ storage: "local", role: "original", kind: "audio", mimeType: "audio/mpeg", bytes: FAKE_MP3.length, status: "verified" });
    expect(rec.files[0].storageKey).toMatch(/^calls\/\d{4}\/\d{2}\/CAtest0001\.mp3$/);
    expect(rec.jobs.map((j) => `${j.stage}:${j.status}`).sort()).toEqual(["extract:pending", "transcribe:pending"]);
    const stored = fs.readFileSync(path.join(t.storage.rootDir, rec.files[0].storageKey));
    expect(crypto.createHash("sha256").update(stored).digest("hex")).toBe(crypto.createHash("sha256").update(FAKE_MP3).digest("hex"));
    // The contractor whose number it is can see the call.
    const kevin = await contractorSession("kevin.mcguire@example.com");
    expect((await kevin.agent.get(`/api/interactions/${res.body.interactionId}`)).status).toBe(200);

    // A repeated callback is a no-op.
    const again = await post("/webhooks/twilio/recording", params);
    expect(again.body.skipped).toBe(true);
    expect((await t.dbHandle.pool.query(`select count(*)::int as n from interactions`)).rows[0].n).toBe(before + 1);
  });

  it("records a failed fetch on the call and returns 500 so Twilio retries", async () => {
    await post("/webhooks/twilio/voice", { CallSid: "CAtest0404", From: "+17135550100", To: "+19365550199" });
    const res = await post("/webhooks/twilio/recording", { CallSid: "CAtest0404", RecordingSid: "RE404", RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/RE404", RecordingStatus: "completed" });
    expect(res.status).toBe(500);
    const call = (await t.dbHandle.pool.query(`select recording_status, recording_error, interaction_id from calls where call_sid = 'CAtest0404'`)).rows[0];
    expect(call.recording_status).toBe("failed");
    expect(call.recording_error).toMatch(/404/);
    expect(call.interaction_id).toBeNull();
  });
});
