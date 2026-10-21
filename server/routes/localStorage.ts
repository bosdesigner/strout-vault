import fs from "node:fs";
import { Router } from "express";
import type { AppContext } from "../context.ts";
import { LocalStorageDriver } from "../storage/local.ts";
import { HttpError, wrap } from "./util.ts";

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

function mimeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Development/test storage endpoints. Only mounted when STORAGE_DRIVER=local.
 * Both routes sit behind the session check AND verify the HMAC signature the
 * driver put in the URL, mirroring presigned S3 URLs.
 */
export function localStorageRouter(ctx: AppContext): Router {
  const r = Router();
  const driver = ctx.storage as LocalStorageDriver;
  if (!(driver instanceof LocalStorageDriver)) return r;

  function checkSig(query: Record<string, unknown>, keys: string[]): Record<string, string> {
    const params: Record<string, string> = {};
    for (const k of [...keys, "exp"]) {
      const v = query[k];
      if (typeof v !== "string") throw new HttpError(400, `missing ${k}`);
      params[k] = v;
    }
    const sig = query.sig;
    if (typeof sig !== "string" || !driver.verify(params, sig)) throw new HttpError(403, "bad or expired signature");
    return params;
  }

  // Browser PUTs each part here (Uppy follows the signed URL).
  r.put(
    "/part",
    wrap(async (req, res) => {
      const p = checkSig(req.query as Record<string, unknown>, ["uploadId", "key", "partNumber"]);
      const out = await driver.writePart(p.uploadId, Number(p.partNumber), req);
      res.setHeader("ETag", out.etag);
      res.setHeader("Access-Control-Expose-Headers", "ETag");
      res.status(200).end();
    }),
  );

  // <video src> points here. Supports Range so seeking works.
  r.get(
    "/object",
    wrap(async (req, res) => {
      const p = checkSig(req.query as Record<string, unknown>, ["key"]);
      const file = driver.pathFor(p.key);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        throw new HttpError(404, "object not found");
      }
      const size = st.size;
      const type = mimeFor(p.key);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "private, max-age=3600");
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) {
          res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
          return;
        }
        let start = m[1] ? Number(m[1]) : NaN;
        let end = m[2] ? Number(m[2]) : NaN;
        if (Number.isNaN(start)) {
          // suffix range: last N bytes
          start = Math.max(0, size - end);
          end = size - 1;
        } else if (Number.isNaN(end) || end >= size) {
          end = size - 1;
        }
        if (start > end || start >= size) {
          res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
          return;
        }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        res.setHeader("Content-Length", String(end - start + 1));
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.status(200);
      res.setHeader("Content-Length", String(size));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
    }),
  );

  return r;
}
