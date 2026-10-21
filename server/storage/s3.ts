import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.ts";
import { assertSafeKey, type HeadResult, type MultipartPart, type ObjectLocation, type PresignedUrl, type StorageDriver } from "./types.ts";

interface Backend {
  client: S3Client;
  bucket: string;
}

/**
 * S3-compatible driver with one configured client per backend:
 *   r2 - Cloudflare R2, where new uploads and proxies live.
 *   b2 - Backblaze B2, where the full-quality originals are archived (read-only here).
 * The backend is chosen from media.storage.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  readonly uploadTarget: { storage: "r2"; bucket: string };
  private readonly backends: Partial<Record<"r2" | "b2", Backend>> = {};

  constructor(config: Config) {
    if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET) {
      throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required for STORAGE_DRIVER=s3");
    }
    this.backends.r2 = {
      bucket: config.R2_BUCKET,
      client: new S3Client({
        region: "auto",
        endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
      }),
    };
    this.uploadTarget = { storage: "r2", bucket: config.R2_BUCKET };

    if (config.B2_KEY_ID && config.B2_APPLICATION_KEY && config.B2_BUCKET && config.B2_REGION) {
      this.backends.b2 = {
        bucket: config.B2_BUCKET,
        client: new S3Client({
          region: config.B2_REGION,
          endpoint: `https://s3.${config.B2_REGION}.backblazeb2.com`,
          credentials: { accessKeyId: config.B2_KEY_ID, secretAccessKey: config.B2_APPLICATION_KEY },
        }),
      };
    }
  }

  canServe(storage: string, _key?: string): boolean {
    return (storage === "r2" && !!this.backends.r2) || (storage === "b2" && !!this.backends.b2);
  }

  private backendFor(location: ObjectLocation): Backend | null {
    const b = location.storage === "r2" ? this.backends.r2 : location.storage === "b2" ? this.backends.b2 : undefined;
    if (!b) return null;
    // A row may name a bucket other than the configured one; honour it.
    return location.bucket && location.bucket !== b.bucket ? { client: b.client, bucket: location.bucket } : b;
  }

  async createMultipartUpload(input: { key: string; contentType?: string | null }) {
    assertSafeKey(input.key);
    const { client, bucket } = this.backends.r2!;
    const out = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: input.key, ContentType: input.contentType ?? undefined }),
    );
    if (!out.UploadId) throw new Error("R2 did not return an UploadId");
    return { uploadId: out.UploadId, key: input.key };
  }

  async signPart(input: { key: string; uploadId: string; partNumber: number }): Promise<PresignedUrl> {
    assertSafeKey(input.key);
    const { client, bucket } = this.backends.r2!;
    const expiresIn = 3600;
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId, PartNumber: input.partNumber }),
      { expiresIn },
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async completeMultipartUpload(input: { key: string; uploadId: string; parts: MultipartPart[] }) {
    assertSafeKey(input.key);
    const { client, bucket } = this.backends.r2!;
    const parts = [...input.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const out = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }),
    );
    return { location: out.Location ?? `r2://${bucket}/${input.key}` };
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }) {
    const { client, bucket } = this.backends.r2!;
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId }));
  }

  async putObject(input: { key: string; body: Buffer; contentType?: string | null }): Promise<{ bytes: number }> {
    assertSafeKey(input.key);
    const { client, bucket } = this.backends.r2!;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentType: input.contentType ?? undefined }));
    return { bytes: input.body.length };
  }

  async presignGet(location: ObjectLocation, opts: { expiresInSec?: number } = {}): Promise<PresignedUrl | null> {
    const backend = this.backendFor(location);
    if (!backend) return null;
    const expiresIn = opts.expiresInSec ?? 6 * 3600;
    const url = await getSignedUrl(backend.client, new GetObjectCommand({ Bucket: backend.bucket, Key: location.key }), {
      expiresIn,
    });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async head(location: ObjectLocation): Promise<HeadResult | null> {
    const backend = this.backendFor(location);
    if (!backend) return null;
    try {
      const out = await backend.client.send(new HeadObjectCommand({ Bucket: backend.bucket, Key: location.key }));
      return { bytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null, etag: out.ETag ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async healthcheck(): Promise<void> {
    const { client, bucket } = this.backends.r2!;
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
