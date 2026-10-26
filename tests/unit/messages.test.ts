// Pure parts of text + email ingestion: redaction, one-time codes, identifiers, routing rules,
// the iMessage collector (Apple epoch, attributedBody, short codes, read-only chat.db copy) and
// Gmail parsing (plain text only, quoted replies and signatures stripped, attachments as metadata).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { abaValid, isOneTimeCode, luhnValid, redactOneTimeCodes, redactSensitive, REDACTED } from "../../server/messages/redact.ts";
import { isShortCode, normalizeEmail, normalizeIdentifier, normalizePhone, ownerIdentity, phoneDigitKeys } from "../../server/messages/identity.ts";
import { localDay, localTime, messagesSha, skipReason, type MessageInput } from "../../server/messages/ingest.ts";
import { emptyRules, parseBlocklist, parseRouting } from "../../server/messages/rules.ts";
import { imessageThreads } from "../../server/messages/imessage.ts";
import { encryptSecret, decryptSecret } from "../../server/messages/crypto.ts";
import { gmailThreadInput, parseAddressList, visibleBody, type GmailThread } from "../../server/messages/gmail/parse.ts";
import { appleTimeToDate, closeCopy, dateToAppleNanos, decodeAttributedBody, isShortCode as collectorShortCode, openChatDbCopy, readMessages } from "../../collectors/imessage/lib.mjs";
import { attributedBody, buildChatDb, SQLITE_AVAILABLE } from "../fixtures/imessage/chatdb.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-msg-unit-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("redaction", () => {
  it("replaces Luhn-valid card numbers, SSNs and bank routing/account numbers with [REDACTED]", () => {
    const input = "Card 4111 1111 1111 1111 or 4111-1111-1111-1111 or 378282246310005; SSN 123-45-6789; routing 021000021, account # 000123456789";
    const r = redactSensitive(input);
    for (const secret of ["4111 1111 1111 1111", "4111-1111-1111-1111", "378282246310005", "123-45-6789", "021000021", "000123456789"]) expect(r.text).not.toContain(secret);
    expect(r.text.match(/\[REDACTED\]/g)?.length).toBe(6);
    expect(r.count).toBe(6);
  });

  it("leaves ordinary numbers alone: phone numbers, prices, dates, a non-Luhn 16-digit id", () => {
    const input = "Call 936-555-0142 about the $12,500 quote on 2026-10-20, order 1234567812345678 ships in 3 days";
    expect(luhnValid("1234567812345678")).toBe(false);
    expect(redactSensitive(input)).toEqual({ text: input, count: 0 });
  });

  it("checks the ABA checksum", () => {
    expect(abaValid("021000021")).toBe(true);
    expect(abaValid("021000022")).toBe(false);
  });

  it("recognises one-time codes and redacts only the code in long emails", () => {
    expect(isOneTimeCode("Your code is 482913")).toBe(true);
    expect(isOneTimeCode("482913 is your Verification code")).toBe(true);
    expect(isOneTimeCode("G-123456 is your Google verification code")).toBe(true);
    expect(isOneTimeCode("OTP: 8841")).toBe(true);
    expect(isOneTimeCode("See you at 6 for the code review")).toBe(false);
    expect(isOneTimeCode("The shoot is on Thursday")).toBe(false);
    const r = redactOneTimeCodes("Thanks for the walkthrough. PS the portal says your code is 771234 if you need it.");
    expect(r.text).not.toContain("771234");
    expect(r.text).toContain(REDACTED);
  });
});

describe("identifiers", () => {
  it("normalises (205) 555-0142, +12055550142 and 205.555.0142 to the same E.164 number", () => {
    expect(new Set(["(205) 555-0142", "+12055550142", "205.555.0142", "+1 205 555 0142", "1-205-555-0142"].map(normalizePhone))).toEqual(new Set(["+12055550142"]));
    expect(phoneDigitKeys("+12055550142")).toEqual(["12055550142", "2055550142"]);
  });

  it("lowercases emails, recognises short codes, and tells Ben apart", () => {
    expect(normalizeEmail(" Kevin.McGuire@Example.com ")).toBe("kevin.mcguire@example.com");
    expect(normalizeIdentifier("48291")).toEqual({ kind: "short_code", value: "48291" });
    expect(normalizeIdentifier("262966")).toEqual({ kind: "short_code", value: "262966" });
    expect(isShortCode("+12055550142")).toBe(false);
    const owner = ownerIdentity({ OWNER_PHONES: "(713) 555-0100", OWNER_EMAILS: "Ben@Example.com" }, ["ben@work.example.com"]);
    expect([...owner.phones]).toEqual(["+17135550100"]);
    expect([...owner.emails].sort()).toEqual(["ben@example.com", "ben@work.example.com"]);
    expect(owner.name).toBe("Ben");
  });
});

describe("filtering before storage", () => {
  const owner = ownerIdentity({ OWNER_EMAILS: "ben@example.com" });
  const msg = (over: Partial<MessageInput>): MessageInput => ({ id: "m", sentAt: new Date(), fromMe: false, from: "+19365550142", text: "hello", ...over });
  const text = { source: "imessage" as const, title: null };
  const mail = { source: "gmail" as const, title: "Re: Conroe" };

  it("skips short codes and one-time codes in texts", () => {
    expect(skipReason(msg({ from: "48291", text: "Your package was delivered" }), text, owner, emptyRules())).toBe("short_code");
    expect(skipReason(msg({ text: "Your code is 482913" }), text, owner, emptyRules())).toBe("one_time_code");
    expect(skipReason(msg({}), text, owner, emptyRules())).toBeNull();
  });

  it("skips Gmail categories, List-Unsubscribe mail, drafts, spam and blocklisted senders", () => {
    const rules = emptyRules();
    rules.blocklist = parseBlocklist({ emails: ["noreply@bank.example.com"], domains: ["marketing.example.com"] });
    expect(skipReason(msg({ from: "a@x.com", labels: ["CATEGORY_PROMOTIONS"] }), mail, owner, rules)).toBe("category_promotions");
    expect(skipReason(msg({ from: "a@x.com", labels: ["CATEGORY_SOCIAL"] }), mail, owner, rules)).toBe("category_social");
    expect(skipReason(msg({ from: "a@x.com", labels: ["CATEGORY_UPDATES"] }), mail, owner, rules)).toBe("category_updates");
    expect(skipReason(msg({ from: "a@x.com", labels: ["CATEGORY_FORUMS"] }), mail, owner, rules)).toBe("category_forums");
    expect(skipReason(msg({ from: "a@x.com", listUnsubscribe: true }), mail, owner, rules)).toBe("list_unsubscribe");
    expect(skipReason(msg({ from: "a@x.com", labels: ["DRAFT"] }), mail, owner, rules)).toBe("draft");
    expect(skipReason(msg({ from: "a@x.com", labels: ["SPAM"] }), mail, owner, rules)).toBe("spam_trash");
    expect(skipReason(msg({ from: "NoReply@bank.example.com" }), mail, owner, rules)).toBe("blocklist");
    expect(skipReason(msg({ from: "promo@marketing.example.com" }), mail, owner, rules)).toBe("blocklist");
    expect(skipReason(msg({ from: "kevin@x.com", labels: ["INBOX", "CATEGORY_PERSONAL"] }), mail, owner, rules)).toBeNull();
    expect(skipReason(msg({ from: "no-reply@accounts.example.com", text: "Your verification code is 552901" }), { source: "gmail", title: "Your verification code" }, owner, rules)).toBe("one_time_code");
  });

  it("reads routing rules: party id and email domain to workspace", () => {
    const r = parseRouting({ parties: { 42: "personal" }, domains: { "@Oakridgebuilders.example.com": "strout_arch" } });
    expect(r.parties.get(42)).toBe("personal");
    expect(r.domains.get("oakridgebuilders.example.com")).toBe("strout_arch");
    expect(() => parseRouting({ parties: { abc: "personal" } })).toThrow(/positive integer/);
    expect(() => parseRouting({ parties: { 1: "Not A Workspace" } })).toThrow(/invalid workspace/);
  });

  it("ships config files with commented examples only", async () => {
    const { loadMessageRules } = await import("../../server/messages/rules.ts");
    const rules = loadMessageRules(path.resolve("config"));
    expect(rules.routing.parties.size + rules.routing.domains.size).toBe(0);
    expect(rules.blocklist.emails.size + rules.blocklist.domains.size + rules.blocklist.phones.size).toBe(0);
  });
});

describe("thread shape", () => {
  it("groups texts per conversation per America/Chicago day", () => {
    const threads = imessageThreads({
      messages: [
        { guid: "a", chat_guid: "c1", sent_at: "2026-10-21T04:30:00Z", is_from_me: false, handle: "+19365550142", text: "late" },
        { guid: "b", chat_guid: "c1", sent_at: "2026-10-22T03:30:00Z", is_from_me: true, text: "later" },
        { guid: "c", chat_guid: "c1", sent_at: "2026-10-22T06:00:00Z", is_from_me: false, handle: "+19365550142", text: "next day" },
        { guid: "d", chat_guid: "c2", sent_at: "2026-10-22T06:00:00Z", is_from_me: false, handle: "+15125550111", text: "other chat" },
      ],
    });
    expect(threads.map((t) => [t.sourceRef, t.messages.map((m) => m.id).join("")])).toEqual([
      ["imessage:c1:2026-10-20", "a"],
      ["imessage:c1:2026-10-21", "b"],
      ["imessage:c1:2026-10-22", "c"],
      ["imessage:c2:2026-10-22", "d"],
    ]);
    expect(localDay(new Date("2026-10-22T03:30:00Z"))).toBe("2026-10-21");
    expect(localTime(new Date("2026-10-20T14:05:00Z"))).toBe("09:05");
  });

  it("hashes message ids and bodies independent of order and line endings", () => {
    const a = messagesSha([{ id: "1", text: "hi\r\nthere" }, { id: "2", text: "yo" }]);
    const b = messagesSha([{ id: "2", text: "yo " }, { id: "1", text: "hi\nthere" }]);
    expect(a).toBe(b);
    expect(messagesSha([{ id: "1", text: "hi there" }])).not.toBe(a);
  });

  it("encrypts refresh tokens with AES-256-GCM and refuses a wrong key", () => {
    const key = "11".repeat(32);
    const sealed = encryptSecret("1//refresh-token", key);
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("refresh-token");
    expect(decryptSecret(sealed, key)).toBe("1//refresh-token");
    expect(() => decryptSecret(sealed, "22".repeat(32))).toThrow();
    expect(() => encryptSecret("x", "short")).toThrow(/32 bytes/);
  });
});

describe("iMessage collector", () => {
  it("converts Apple epoch timestamps (nanoseconds and legacy seconds since 2001-01-01)", () => {
    expect(appleTimeToDate(0)).toBeNull();
    expect(appleTimeToDate(783691200000000000n)!.toISOString()).toBe("2025-11-01T12:00:00.000Z");
    expect(appleTimeToDate(783691200)!.toISOString()).toBe("2025-11-01T12:00:00.000Z");
    expect(appleTimeToDate(Number(783691200123000000n))!.toISOString()).toBe("2025-11-01T12:00:00.123Z");
    const d = new Date("2026-10-20T14:05:00.250Z");
    expect(appleTimeToDate(dateToAppleNanos(d))!.toISOString()).toBe(d.toISOString());
  });

  it("decodes attributedBody (typedstream NSAttributedString) when text is null", () => {
    expect(decodeAttributedBody(attributedBody("Hello"))).toBe("Hello");
    expect(decodeAttributedBody(attributedBody("Sent the Conroe shot list ✅"))).toBe("Sent the Conroe shot list ✅");
    const long = "Long message ".repeat(30).trim();
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(Buffer.from("not a typedstream"))).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
  });

  // node:sqlite needs Node 22.13+ (what the collector requires on the Mac); the vault itself runs on 20.
  it.skipIf(!SQLITE_AVAILABLE)("reads a synthetic chat.db from a read-only copy and skips short codes, codes, reactions and events", () => {
    const file = path.join(tmp, "chat.db");
    buildChatDb(file);
    const before = fs.statSync(file).mtimeMs;
    const copy = openChatDbCopy(file);
    let rows;
    try {
      expect(() => copy.db.exec(`insert into handle (id) values ('x')`)).toThrow(/readonly/);
      rows = readMessages(copy.db, 0, 1000);
    } finally {
      closeCopy(copy);
    }
    expect(fs.existsSync(copy.dir)).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    const byGuid = new Map(rows.map((r) => [r.message?.guid ?? `skip:${r.rowid}`, r]));
    expect(rows.filter((r) => r.skip === "short_code")).toHaveLength(1);
    expect(rows.filter((r) => r.skip === "one_time_code")).toHaveLength(1);
    expect(rows.filter((r) => r.skip === "reaction")).toHaveLength(1);
    expect(rows.filter((r) => r.skip === "system")).toHaveLength(1);
    expect(byGuid.get("fx-k-5")!.message!.text).toBe("Sent the Conroe shot list ✅");
    expect(byGuid.get("fx-k-5")!.message!.sent_at).toBe("2026-10-21T04:30:00.000Z");
    expect(byGuid.get("fx-k-7")!.message!.attachments).toEqual([{ filename: "IMG_0412.HEIC", mime: "image/heic", size: 2481337 }]);
    expect(byGuid.get("fx-g-1")!.message!.chat_participants.sort()).toEqual(["+15125550177", "+19365550142"]);
    expect(byGuid.get("fx-k-2")!.message!.handle).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("482913");
    // The API suite posts this file instead of reading chat.db; keep it equal to what the collector sends.
    const payload = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/imessage/collector-payload.json"), "utf8"));
    expect(rows.filter((r) => r.message).map((r) => r.message)).toEqual(payload);
    expect(collectorShortCode("48291")).toBe(true);
    expect(collectorShortCode("+12055550142")).toBe(false);
  });
});

describe("Gmail parsing", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  it("keeps the plain-text part only, strips the quoted reply and signature, and keeps attachments as metadata", () => {
    const thread: GmailThread = {
      id: "t1",
      historyId: "100",
      messages: [
        {
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX"],
          internalDate: String(Date.parse("2026-10-20T15:00:00Z")),
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: '"McGuire, Kevin" <Kevin.McGuire@example.com>' },
              { name: "To", value: "Ben <ben@example.com>, \"Lena, F\" <lena@gulfcoastmillwork.example.com>" },
              { name: "Subject", value: "Conroe schedule" },
            ],
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/plain", body: { data: b64("Thursday works.\n\nThanks,\nKevin\n--\nKevin McGuire\nCamera & Drone\n\nOn Mon, Oct 19, 2026 at 9:00 AM Ben <ben@example.com> wrote:\n> Does Thursday work?\n> Ben\n") } },
                  { mimeType: "text/html", body: { data: b64("<p>Thursday works.</p><img src=x>") } },
                ],
              },
              { mimeType: "application/pdf", filename: "shot-list.pdf", body: { size: 48213, attachmentId: "att1" } },
            ],
          },
        },
      ],
    };
    const t = gmailThreadInput("Ben@Example.com", thread);
    expect(t.sourceRef).toBe("gmail:ben@example.com:t1");
    expect(t.title).toBe("Conroe schedule");
    expect(t.kind).toBe("email_thread");
    const m = t.messages[0];
    expect(m.text).toBe("Thursday works.\n\nThanks,\nKevin");
    expect(m.text).not.toContain("Does Thursday work");
    expect(m.text).not.toContain("<p>");
    expect(m.from).toBe("Kevin.McGuire@example.com");
    expect(m.fromName).toBe("McGuire, Kevin");
    expect(m.to).toEqual(["ben@example.com", "lena@gulfcoastmillwork.example.com"]);
    expect(m.attachments).toEqual([{ filename: "shot-list.pdf", mime: "application/pdf", size: 48213 }]);
    expect(JSON.stringify(t)).not.toContain("att1");
  });

  it("strips 'Sent from my iPhone' and splits address lists on unquoted commas only", () => {
    expect(visibleBody("Yes.\n\nSent from my iPhone\n\nOn Tue, Ben wrote:\n> ok?")).toBe("Yes.");
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com').map((a) => a.email)).toEqual(["jane@x.com", "bob@y.com"]);
  });
});
