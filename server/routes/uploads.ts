import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { uploadKey, sanitizeFilename } from "../storage/types.ts";
import { findDuplicateBySha, finishUpload, UploadError } from "../services/upload.ts";
import { ACCEPTED_UPLOAD_EXTENSIONS } from "../../shared/types.ts";
import { HttpError, parse, wrap } from "./util.ts";

const sha = z.string().regex(/^[a-f0-9]{64}$/i, "sha256 must be 64 hex characters");
const keySchema = z.string().min(1).max(1024);
const uploadIdSchema = z.string().min(1).max(2048);

const createSchema = z.object({
  filename: z.string().min(1).max(500),
  type: z.string().max(200).nullable().optional(),
  size: z.number().int().nonnegative(),
});

const partsSchema = z.array(z.object({ PartNumber: z.number().int().min(1).max(10000), ETag: z.string().min(1).max(200) })).min(1);

const finishSchema = z.object({
  key: keySchema,
  sha256: sha,
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().max(200).nullable(),
  originalFilename: z.string().min(1).max(500),
  title: z.string().max(300),
  recordedAt: z.string().min(4).max(40),
  workspaceId: z.string().max(100).nullable(),
  source: z.enum(["upload", "iphone_call", "contractor_call"]),
  partyIds: z.array(z.number().int().positive()).max(50),
});

function acceptedExtension(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

export function uploadsRouter(ctx: AppContext): Router {
  const r = Router();

  // Before uploading: is this exact file already in the vault?
  r.post(
    "/check",
    wrap(async (req, res) => {
      const { sha256 } = parse(z.object({ sha256: sha }), req.body);
      const dup = await findDuplicateBySha(ctx.pool, sha256);
      res.json({ duplicate: dup });
    }),
  );

  // Uppy AwsS3 multipart hooks ------------------------------------------------
  r.post(
    "/multipart",
    wrap(async (req, res) => {
      const body = parse(createSchema, req.body);
      const name = sanitizeFilename(body.filename);
      if (!acceptedExtension(name)) {
        throw new HttpError(415, `Unsupported file type. Accepted: ${ACCEPTED_UPLOAD_EXTENSIONS.join(", ").toUpperCase()}`);
      }
      const key = uploadKey(name, new Date(), crypto.randomUUID());
      const out = await ctx.storage.createMultipartUpload({ key, contentType: body.type ?? null });
      res.json({ uploadId: out.uploadId, key: out.key });
    }),
  );

  r.get(
    "/multipart/:uploadId/:partNumber",
    wrap(async (req, res) => {
      const uploadId = parse(uploadIdSchema, req.params.uploadId);
      const partNumber = parse(z.coerce.number().int().min(1).max(10000), req.params.partNumber);
      const key = parse(keySchema, req.query.key);
      const signed = await ctx.storage.signPart({ key, uploadId, partNumber });
      res.json({ url: signed.url, headers: signed.headers ?? {}, expires: Math.floor((signed.expiresAt.getTime() - Date.now()) / 1000) });
    }),
  );

  r.get("/multipart/:uploadId", (_req, res) => {
    // Resuming an interrupted upload lists its parts; we keep state in the browser instead, so report none.
    res.json([]);
  });

  r.post(
    "/multipart/:uploadId/complete",
    wrap(async (req, res) => {
      const uploadId = parse(uploadIdSchema, req.params.uploadId);
      const key = parse(keySchema, req.query.key);
      const { parts } = parse(z.object({ parts: partsSchema }), req.body);
      const out = await ctx.storage.completeMultipartUpload({ key, uploadId, parts });
      res.json({ location: out.location });
    }),
  );

  r.delete(
    "/multipart/:uploadId",
    wrap(async (req, res) => {
      const uploadId = parse(uploadIdSchema, req.params.uploadId);
      const key = parse(keySchema, req.query.key);
      await ctx.storage.abortMultipartUpload({ key, uploadId });
      res.json({ ok: true });
    }),
  );

  // After the bytes are in storage: write the rows in one transaction.
  r.post(
    "/finish",
    wrap(async (req, res) => {
      const input = parse(finishSchema, req.body);
      if (!acceptedExtension(input.originalFilename)) throw new HttpError(415, "Unsupported file type");
      try {
        const owner = req.session?.role === "owner";
        const out = await finishUpload(ctx.pool, ctx.storage, input, {
          uploadedBy: req.session?.partyId ?? null,
          forceWorkspaceId: owner ? undefined : req.session?.workspaceId ?? null,
        });
        res.status(201).json(out);
      } catch (err) {
        if (err instanceof UploadError) {
          res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
          return;
        }
        throw err;
      }
    }),
  );

  return r;
}
