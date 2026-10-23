import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { assertSafeKey, isSafeKey, type HeadResult, type MultipartPart, type ObjectLocation, type PresignedUrl, type StorageDriver } from "./types.ts";

/**
 * Local filesystem driver for development and tests. Files live under
 * `rootDir`; the browser talks to it through authenticated routes on this
 * app (see routes/localStorage.ts) using HMAC-signed URLs so the flow is the
 * same shape as presigned S3 URLs.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;
  readonly uploadTarget = { storage: "local" as const, bucket: null };
  readonly rootDir: string;
  private readonly secret: string;

  constructor(opts: { rootDir: string; secret: string }) {
    this.rootDir = path.resolve(opts.rootDir);
    this.secret = opts.secret;
    fs.mkdirSync(path.join(this.rootDir, ".uploads"), { recursive: true });
  }

  canServe(storage: string, key?: string): boolean {
    return storage === "local" && (key === undefined || isSafeKey(key));
  }

  /** Absolute path for a key, guaranteed to stay inside rootDir. */
  pathFor(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.rootDir, key);
    if (!p.startsWith(this.rootDir + path.sep)) throw new Error("invalid storage key");
    return p;
  }

  private uploadDir(uploadId: string): string {
    if (!/^[a-f0-9]{32}$/.test(uploadId)) throw new Error("invalid uploadId");
    return path.join(this.rootDir, ".uploads", uploadId);
  }

  sign(params: Record<string, string>): string {
    const canonical = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return crypto.createHmac("sha256", this.secret).update(canonical).digest("base64url");
  }

  verify(params: Record<string, string>, sig: string): boolean {
    const expected = this.sign(params);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const exp = Number(params.exp);
    return Number.isFinite(exp) && exp * 1000 > Date.now();
  }

  private signedUrl(pathname: string, params: Record<string, string>, expiresInSec: number): PresignedUrl {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const all = { ...params, exp: String(exp) };
    const sig = this.sign(all);
    const qs = new URLSearchParams({ ...all, sig });
    return { url: `${pathname}?${qs.toString()}`, expiresAt: new Date(exp * 1000) };
  }

  async createMultipartUpload(input: { key: string; contentType?: string | null }) {
    assertSafeKey(input.key);
    const uploadId = crypto.randomBytes(16).toString("hex");
    const dir = this.uploadDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ key: input.key, contentType: input.contentType ?? null, createdAt: new Date().toISOString() }),
    );
    return { uploadId, key: input.key };
  }

  async signPart(input: { key: string; uploadId: string; partNumber: number }): Promise<PresignedUrl> {
    assertSafeKey(input.key);
    this.uploadDir(input.uploadId);
    return this.signedUrl(
      "/api/storage/local/part",
      { uploadId: input.uploadId, key: input.key, partNumber: String(input.partNumber) },
      3600,
    );
  }

  /** Called by the PUT route: streams one part to disk and returns its ETag (md5, like S3). */
  async writePart(uploadId: string, partNumber: number, body: NodeJS.ReadableStream): Promise<{ etag: string; bytes: number }> {
    const dir = this.uploadDir(uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("invalid partNumber");
    await fsp.access(path.join(dir, "meta.json"));
    const file = path.join(dir, `part-${String(partNumber).padStart(5, "0")}`);
    const hash = crypto.createHash("md5");
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(file);
      body.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      body.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
      body.pipe(out);
    });
    return { etag: `"${hash.digest("hex")}"`, bytes };
  }

  async completeMultipartUpload(input: { key: string; uploadId: string; parts: MultipartPart[] }) {
    const dir = this.uploadDir(input.uploadId);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8")) as { key: string };
    if (meta.key !== input.key) throw new Error("key does not match upload");
    const dest = this.pathFor(input.key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const parts = [...input.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const out = fs.createWriteStream(dest);
    for (const p of parts) {
      const file = path.join(dir, `part-${String(p.PartNumber).padStart(5, "0")}`);
      await new Promise<void>((resolve, reject) => {
        const inp = fs.createReadStream(file);
        inp.on("error", reject);
        inp.on("end", () => resolve());
        inp.pipe(out, { end: false });
      });
    }
    await new Promise<void>((resolve, reject) => {
      out.on("error", reject);
      out.end(() => resolve());
    });
    // Parts are scratch data of this upload, not vault content; tidy them up.
    await fsp.rm(dir, { recursive: true, force: true });
    return { location: `local://${input.key}` };
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }) {
    const dir = this.uploadDir(input.uploadId);
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async putObject(input: { key: string; body: Buffer; contentType?: string | null }): Promise<{ bytes: number }> {
    const dest = this.pathFor(input.key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, input.body);
    return { bytes: input.body.length };
  }

  readonly archiveTarget = { storage: "local" as const, bucket: null };

  /** Streams to `<key>.part` and renames on completion, so an interrupted write never looks finished. */
  async putStream(input: { storage?: string; key: string; body: NodeJS.ReadableStream; contentType?: string | null }): Promise<{ bytes: number; sha256: string }> {
    if (input.storage && input.storage !== "local") throw new Error(`local driver cannot write to storage ${input.storage}`);
    const dest = this.pathFor(input.key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(part);
        input.body.on("data", (chunk: Buffer) => {
          hash.update(chunk);
          bytes += chunk.length;
        });
        input.body.on("error", (err) => {
          out.destroy();
          reject(err);
        });
        out.on("error", reject);
        out.on("finish", () => resolve());
        input.body.pipe(out);
      });
      await fsp.rename(part, dest);
    } catch (err) {
      await fsp.rm(part, { force: true });
      throw err;
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  async getObjectStream(location: ObjectLocation): Promise<{ stream: NodeJS.ReadableStream; bytes: number | null } | null> {
    if (!this.canServe(location.storage, location.key)) return null;
    const file = this.pathFor(location.key);
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return null;
      return { stream: fs.createReadStream(file), bytes: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async presignGet(location: ObjectLocation, opts: { expiresInSec?: number } = {}): Promise<PresignedUrl | null> {
    if (!this.canServe(location.storage, location.key)) return null;
    return this.signedUrl("/api/storage/local/object", { key: location.key }, opts.expiresInSec ?? 6 * 3600);
  }

  async head(location: ObjectLocation): Promise<HeadResult | null> {
    if (!this.canServe(location.storage, location.key)) return null;
    try {
      const st = await fsp.stat(this.pathFor(location.key));
      if (!st.isFile()) return null;
      return { bytes: st.size, contentType: null, etag: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async healthcheck(): Promise<void> {
    await fsp.access(this.rootDir, fs.constants.R_OK | fs.constants.W_OK);
  }
}
