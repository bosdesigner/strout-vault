// Who sent a message: phone numbers normalised to E.164 (libphonenumber-js, default region US),
// emails lowercased, short codes recognised, social handles as "<platform>:<username>" (TikTok and
// Instagram DMs), and Ben's own identifiers (OWNER_PHONES / OWNER_EMAILS / OWNER_HANDLES, plus each
// connected Gmail or Instagram account) told apart from everyone else.
import { parsePhoneNumberFromString } from "libphonenumber-js";

export type IdentifierKind = "phone" | "email" | "handle" | "short_code" | "other";

export const SOCIAL_PLATFORMS = ["tiktok", "instagram"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const PLATFORM_LABEL: Record<SocialPlatform, string> = { tiktok: "TikTok", instagram: "Instagram" };

export interface Identifier {
  kind: IdentifierKind;
  /** E.164 for phones, lowercase for emails, "<platform>:<username>" for handles, digits for short codes, trimmed text otherwise. */
  value: string;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  return EMAIL.test(s) ? s : null;
}

/** E.164 ("+12055550142") or null. US is the default region for numbers without a country code. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || /@/.test(s)) return null;
  const parsed = parsePhoneNumberFromString(s, "US");
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** 5-6 digit SMS short codes (banks, delivery, 2FA): never a person. */
export function isShortCode(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  return /^\d{5,6}$/.test(s.replace(/[\s-]/g, "")) && !/^\+/.test(s);
}

const HANDLE_PREFIX = /^(tiktok|instagram):\s*@?(.+)$/i;

/**
 * "tiktok:hemakesbigmoves" for ("tiktok", "@HeMakesBigMoves"), or null. Usernames are lowercased
 * (both platforms treat them case-insensitively) and keep only what the platforms allow:
 * letters, digits, "." and "_".
 */
export function normalizeHandle(platform: string, raw: string | null | undefined): string | null {
  const p = platform.trim().toLowerCase();
  if (!(SOCIAL_PLATFORMS as readonly string[]).includes(p)) return null;
  const user = (raw ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,64}$/.test(user)) return null;
  return `${p}:${user}`;
}

/** "@hemakesbigmoves" for "tiktok:hemakesbigmoves". */
export function handleDisplay(value: string): string {
  const i = value.indexOf(":");
  return i < 0 ? value : `@${value.slice(i + 1)}`;
}

export function handlePlatform(value: string): SocialPlatform | null {
  const p = value.slice(0, value.indexOf(":"));
  return (SOCIAL_PLATFORMS as readonly string[]).includes(p) ? (p as SocialPlatform) : null;
}

export function normalizeIdentifier(raw: string | null | undefined): Identifier | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // Before phones: "tiktok:2055550142" is a username made of digits, not a phone number.
  const h = HANDLE_PREFIX.exec(s);
  if (h) {
    const v = normalizeHandle(h[1], h[2]);
    return v ? { kind: "handle", value: v } : { kind: "other", value: s.slice(0, 200) };
  }
  if (isShortCode(s)) return { kind: "short_code", value: s.replace(/\D/g, "") };
  const email = normalizeEmail(s);
  if (email) return { kind: "email", value: email };
  const phone = normalizePhone(s);
  if (phone) return { kind: "phone", value: phone };
  return { kind: "other", value: s.slice(0, 200) };
}

/** Digit strings a stored phone may reduce to for this E.164 number ("12055550142" and, for +1, "2055550142"). */
export function phoneDigitKeys(e164: string): string[] {
  const digits = e164.replace(/\D/g, "");
  return e164.startsWith("+1") && digits.length === 11 ? [digits, digits.slice(1)] : [digits];
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

export interface OwnerIdentity {
  phones: Set<string>;
  emails: Set<string>;
  /** "<platform>:<username>" for Ben's own accounts (OWNER_HANDLES, plus connected Instagram accounts). */
  handles: Set<string>;
  /** Shown as the speaker of Ben's own messages. */
  name: string;
}

export function ownerIdentity(
  config: { OWNER_PHONES?: string; OWNER_EMAILS?: string; OWNER_HANDLES?: string; OWNER_NAME?: string },
  extraEmails: string[] = [],
  extraHandles: string[] = [],
): OwnerIdentity {
  const split = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const phones = new Set(split(config.OWNER_PHONES).map(normalizePhone).filter((x): x is string => !!x));
  const emails = new Set([...split(config.OWNER_EMAILS), ...extraEmails].map(normalizeEmail).filter((x): x is string => !!x));
  const handles = new Set(
    [...split(config.OWNER_HANDLES), ...extraHandles]
      .map((h) => normalizeIdentifier(h))
      .filter((x): x is Identifier => x?.kind === "handle")
      .map((x) => x.value),
  );
  return { phones, emails, handles, name: config.OWNER_NAME?.trim() || "Ben" };
}

export function isOwner(owner: OwnerIdentity, id: Identifier | null): boolean {
  if (!id) return false;
  return (id.kind === "phone" && owner.phones.has(id.value)) || (id.kind === "email" && owner.emails.has(id.value)) || (id.kind === "handle" && (owner.handles?.has(id.value) ?? false));
}
