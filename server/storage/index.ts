import type { Config } from "../config.ts";
import { LocalStorageDriver } from "./local.ts";
import { S3StorageDriver } from "./s3.ts";
import type { StorageDriver } from "./types.ts";

export type { StorageDriver, ObjectLocation, PresignedUrl, HeadResult, MultipartPart } from "./types.ts";
export { LocalStorageDriver } from "./local.ts";
export { S3StorageDriver } from "./s3.ts";

export function createStorage(config: Config): StorageDriver {
  if (config.STORAGE_DRIVER === "s3") return new S3StorageDriver(config);
  return new LocalStorageDriver({ rootDir: config.LOCAL_STORAGE_DIR, secret: config.SESSION_SECRET });
}
