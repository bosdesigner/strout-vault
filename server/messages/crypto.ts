// Gmail refresh tokens at rest: AES-256-GCM with MESSAGES_ENCRYPTION_KEY. The vault had no
// reversible-secret pattern before (API and OAuth tokens it issues are stored as SHA-256 hashes,
// which works only for tokens it verifies, not for tokens it must send to Google).
// Format: "v1:<iv>:<tag>:<ciphertext>", each part base64url.
import crypto from "node:crypto";

export function parseKey(raw: string | undefined): Buffer {
  const s = (raw ?? "").trim();
  if (!s) throw new Error("MESSAGES_ENCRYPTION_KEY is not set (32 random bytes, hex or base64)");
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error("MESSAGES_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptSecret(plain: string, rawKey: string | undefined): string {
  const key = parseKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(sealed: string, rawKey: string | undefined): string {
  const key = parseKey(rawKey);
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised encrypted secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
