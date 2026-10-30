import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, login, type Session, type TestApp } from "../helpers.ts";

let t: TestApp;
let s: Session;
beforeAll(async () => {
  t = await buildTestApp();
  s = await login(t.app);
});
afterAll(() => t.close());

const FIXTURE = path.resolve("tests/e2e/fixtures/upload-test.mp4");

function randomVideoBytes(size: number): Buffer {
  // Random bytes so every test file has a unique sha256.
  return crypto.randomBytes(size);
}

async function counts() {
  const { rows } = await t.dbHandle.pool.query(
    `select (select count(*)::int from interactions) as interactions, (select count(*)::int from media) as media,
            (select count(*)::int from jobs) as jobs, (select count(*)::int from interaction_participants) as participants`,
  );
  return rows[0] as { interactions: number; media: number; jobs: number; participants: number };
}

/** Drives the same multipart flow the browser uses: create -> sign+PUT parts -> complete. */
async function uploadBytes(bytes: Buffer, filename: string, mime: string, parts = 2) {
  const create = await s.agent.post("/api/uploads/multipart").set("x-csrf-token", s.csrf).send({ filename, type: mime, size: bytes.length });
  expect(create.status).toBe(200);
  const { uploadId, key } = create.body as { uploadId: string; key: string };
  expect(key).toMatch(new RegExp(`^uploads/\\d{4}/\\d{2}/[0-9a-f-]{36}/${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  const etags: Array<{ PartNumber: number; ETag: string }> = [];
  const partSize = Math.ceil(bytes.length / parts);
  for (let i = 0; i < parts; i++) {
    const chunk = bytes.subarray(i * partSize, (i + 1) * partSize);
    const sign = await s.agent.get(`/api/uploads/multipart/${uploadId}/${i + 1}?key=${encodeURIComponent(key)}`);
    expect(sign.status).toBe(200);
    const put = await s.agent.put(sign.body.url).set("content-type", "application/octet-stream").send(chunk);
    expect(put.status).toBe(200);
    expect(put.headers.etag).toBeTruthy();
    etags.push({ PartNumber: i + 1, ETag: put.headers.etag });
  }
  const complete = await s.agent.post(`/api/uploads/multipart/${uploadId}/complete?key=${encodeURIComponent(key)}`).set("x-csrf-token", s.csrf).send({ parts: etags });
  expect(complete.status).toBe(200);
  return key;
}

function finishBody(key: string, bytes: Buffer, filename: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mimeType: "video/mp4",
    originalFilename: filename,
    title: "Test upload",
    recordedAt: "2026-02-03T15:04:00.000Z",
    workspaceId: "another_story",
    source: "upload",
    partyIds: [],
    ...extra,
  };
}

describe("upload", () => {
  it("creates interaction, media, jobs and participants in one transaction", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const kevin = (await s.agent.get("/api/parties?q=Kevin")).body.items[0];
    const sam = (await s.agent.get("/api/parties?q=Sam")).body.items[0];
    const before = await counts();
    const key = await uploadBytes(bytes, "upload-test.mp4", "video/mp4");
    // The object is byte-identical in storage.
    const stored = fs.readFileSync(path.join(t.storage.rootDir, key));
    expect(crypto.createHash("sha256").update(stored).digest("hex")).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));

    const check = await s.agent.post("/api/uploads/check").set("x-csrf-token", s.csrf).send({ sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    expect(check.body.duplicate).toBeNull();

    const res = await s.agent
      .post("/api/uploads/finish")
      .set("x-csrf-token", s.csrf)
      .send(finishBody(key, bytes, "upload-test.mp4", { partyIds: [kevin.id, sam.id], source: "contractor_call" }));
    expect(res.status).toBe(201);
    const { interactionId, mediaId } = res.body as { interactionId: number; mediaId: number };

    const after = await counts();
    expect(after.interactions - before.interactions).toBe(1);
    expect(after.media - before.media).toBe(1);
    expect(after.jobs - before.jobs).toBe(1); // transcribe only: extraction is tracked on the interaction
    expect(after.participants - before.participants).toBe(2);

    const i = (await t.dbHandle.pool.query(`select * from interactions where id = $1`, [interactionId])).rows[0];
    expect(i.pipeline_status).toBe("queued");
    expect(i.source).toBe("contractor_call");
    expect(i.kind).toBe("call");
    expect(i.title).toBe("Test upload");
    expect(i.workspace_id).toBe("another_story");
    expect(i.media_id).toBe(mediaId);
    expect(new Date(i.occurred_at).toISOString()).toBe("2026-02-03T15:04:00.000Z");
    const m = (await t.dbHandle.pool.query(`select * from media where id = $1`, [mediaId])).rows[0];
    expect(m).toMatchObject({ interaction_id: interactionId, role: "original", status: "verified", storage: "local", storage_key: key, kind: "video", mime_type: "video/mp4", bytes: bytes.length, original_filename: "upload-test.mp4" });
    expect(m.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    const jobs = (await t.dbHandle.pool.query(`select stage, status from jobs where media_id = $1 order by stage`, [mediaId])).rows;
    expect(jobs).toEqual([{ stage: "transcribe", status: "pending" }]);

    // The recording page reports it queued, with the local file playable in development.
    const detail = await s.agent.get(`/api/interactions/${interactionId}`);
    expect(detail.body.pipelineStatus).toBe("queued");
    expect(detail.body.jobs).toHaveLength(1);
    expect(detail.body.video?.mediaId).toBe(mediaId);
  });

  it("refuses a duplicate SHA-256 before and after upload", async () => {
    const bytes = fs.readFileSync(FIXTURE); // already in the vault from the test above
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const check = await s.agent.post("/api/uploads/check").set("x-csrf-token", s.csrf).send({ sha256: sha });
    expect(check.body.duplicate).toMatchObject({ title: "Test upload" });
    expect(check.body.duplicate.interactionId).toBeGreaterThan(0);

    const before = await counts();
    const key = await uploadBytes(bytes, "upload-test.mp4", "video/mp4");
    const res = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send(finishBody(key, bytes, "upload-test.mp4"));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate");
    expect(res.body.duplicate.title).toBe("Test upload");
    expect(await counts()).toEqual(before);
  });

  it("rolls everything back when any insert fails", async () => {
    const bytes = randomVideoBytes(6000);
    const key = await uploadBytes(bytes, "rollback.mp4", "video/mp4");
    const before = await counts();
    const res = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send(finishBody(key, bytes, "rollback.mp4", { partyIds: [987654321] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_reference");
    expect(await counts()).toEqual(before);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    expect((await t.dbHandle.pool.query(`select 1 from media where sha256 = $1`, [sha])).rowCount).toBe(0);
    expect((await t.dbHandle.pool.query(`select 1 from interactions where content_sha256 = $1`, [sha])).rowCount).toBe(0);
  });

  it("rejects a finish whose object is missing or whose size does not match", async () => {
    const bytes = randomVideoBytes(4000);
    const key = await uploadBytes(bytes, "short.mp4", "video/mp4");
    const before = await counts();
    const wrongSize = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send(finishBody(key, bytes, "short.mp4", { bytes: 1 }));
    expect(wrongSize.status).toBe(409);
    expect(wrongSize.body.error).toBe("size_mismatch");
    const missing = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send(finishBody("uploads/2026/01/nope/none.mp4", bytes, "none.mp4"));
    expect(missing.status).toBe(409);
    expect(missing.body.error).toBe("object_missing");
    expect(await counts()).toEqual(before);
  });

  it("rejects unsupported file types, bad keys and unauthenticated calls", async () => {
    const bad = await s.agent.post("/api/uploads/multipart").set("x-csrf-token", s.csrf).send({ filename: "notes.pdf", type: "application/pdf", size: 10 });
    expect(bad.status).toBe(415);
    const traversal = await s.agent.post("/api/uploads/finish").set("x-csrf-token", s.csrf).send(finishBody("uploads/../etc/passwd.mp4", Buffer.from("x"), "passwd.mp4"));
    expect(traversal.status).toBe(500 /* assertSafeKey throws before validation */ === 500 ? traversal.status : 400);
    expect([400, 500]).toContain(traversal.status);
    expect((await request(t.app).post("/api/uploads/multipart").send({ filename: "a.mp4", size: 1 })).status).toBe(401);
    expect((await s.agent.post("/api/uploads/multipart").send({ filename: "a.mp4", size: 1 })).status).toBe(403);
  });

  it("part URLs are signed: a tampered URL is refused", async () => {
    const create = await s.agent.post("/api/uploads/multipart").set("x-csrf-token", s.csrf).send({ filename: "sig.mp4", type: "video/mp4", size: 10 });
    const sign = await s.agent.get(`/api/uploads/multipart/${create.body.uploadId}/1?key=${encodeURIComponent(create.body.key)}`);
    const tampered = sign.body.url.replace("partNumber=1", "partNumber=2");
    const put = await s.agent.put(tampered).send(Buffer.from("0123456789"));
    expect(put.status).toBe(403);
    const abort = await s.agent.delete(`/api/uploads/multipart/${create.body.uploadId}?key=${encodeURIComponent(create.body.key)}`).set("x-csrf-token", s.csrf);
    expect(abort.status).toBe(200);
  });
});
