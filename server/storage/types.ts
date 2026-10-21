// One interface in front of every place a file can live. The app never
// deletes objects: there is no delete method on purpose.

export interface ObjectLocation {
  storage: string; // media.storage: r2 | b2 | local | zoom | s3_deep_archive
  bucket: string | null;
  key: string;
}

export interface MultipartPart {
  PartNumber: number;
  ETag: string;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
  /** Extra headers the browser must send with the request (S3 needs none). */
  headers?: Record<string, string>;
}

export interface HeadResult {
  bytes: number;
  contentType: string | null;
  etag: string | null;
}

export interface StorageDriver {
  /** Driver name, for /healthz and logs. */
  readonly name: "s3" | "local";
  /** Where new uploads land; written to media.storage / media.bucket. */
  readonly uploadTarget: { storage: "r2" | "local"; bucket: string | null };
  /**
   * Whether a media row (storage value, and optionally its key) can be played from the web
   * through this driver. The local driver only serves relative keys under its root: production
   * rows with storage='local' hold absolute Mac paths and are never playable.
   */
  canServe(storage: string, key?: string): boolean;

  createMultipartUpload(input: { key: string; contentType?: string | null }): Promise<{ uploadId: string; key: string }>;
  signPart(input: { key: string; uploadId: string; partNumber: number }): Promise<PresignedUrl>;
  completeMultipartUpload(input: { key: string; uploadId: string; parts: MultipartPart[] }): Promise<{ location: string }>;
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;

  /** Presigned GET for playback or download. Returns null when this driver cannot serve the location. */
  presignGet(location: ObjectLocation, opts?: { expiresInSec?: number }): Promise<PresignedUrl | null>;
  /** Object metadata, or null when the object does not exist. */
  head(location: ObjectLocation): Promise<HeadResult | null>;
  /** Cheap reachability check for /healthz. Throws when storage is unreachable. */
  healthcheck(): Promise<void>;
}

/** Keep object keys to a safe, predictable shape: no traversal, no control chars. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  for (const part of key.split("/")) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

export function assertSafeKey(key: string): void {
  if (!isSafeKey(key)) throw new Error("invalid storage key");
}

/** Storage key for a new upload: uploads/<yyyy>/<mm>/<uuid>/<original filename>. */
export function uploadKey(originalFilename: string, now: Date, uuid: string): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const safeName = sanitizeFilename(originalFilename);
  return `uploads/${yyyy}/${mm}/${uuid}/${safeName}`;
}

export function sanitizeFilename(name: string): string {
  // Keep the original name readable, but strip path separators and control chars.
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned.slice(0, 200);
}
