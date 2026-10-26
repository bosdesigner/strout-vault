// The iMessage collector's pure parts: reading chat.db read-only, decoding message bodies,
// converting Apple timestamps, and shaping batches for POST /api/ingest/messages. No network
// and no logging of message text here; collector.mjs does the I/O and prints counts only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Unarchiver } from "node-typedstream";

/** node:sqlite (Node 22.13+), loaded only when a chat.db is opened so the pure helpers load anywhere. */
export function loadSqlite() {
  return createRequire(import.meta.url)("node:sqlite");
}

/** Seconds between the Unix epoch and Apple's (2001-01-01T00:00:00Z). */
export const APPLE_EPOCH_OFFSET_SEC = 978307200;

/**
 * chat.db `date` columns: nanoseconds since 2001-01-01 on macOS 10.13 and later, seconds before
 * that. Returns null for 0 / missing.
 */
export function appleTimeToDate(value) {
  if (value === null || value === undefined) return null;
  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  if (v === 0n) return null;
  // Anything above ~1e11 cannot be seconds (that would be the year 5000+): it is nanoseconds.
  const ms = v > 100_000_000_000n ? Number(v / 1_000_000n) : Number(v) * 1000;
  return new Date(ms + APPLE_EPOCH_OFFSET_SEC * 1000);
}

/** Inverse of appleTimeToDate (nanoseconds), for fixtures. */
export function dateToAppleNanos(date) {
  return (BigInt(date.getTime()) - BigInt(APPLE_EPOCH_OFFSET_SEC * 1000)) * 1_000_000n;
}

function findString(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.string === "string") return value.string;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const s = findString(v, seen);
    if (s !== null) return s;
  }
  return null;
}

/**
 * The text of a message whose `text` column is null: newer macOS stores the body only in
 * `attributedBody`, an NSAttributedString archived as an Apple typedstream. Decoded with
 * node-typedstream (a port of dgelessus/python-typedstream). Null when it holds no string.
 */
export function decodeAttributedBody(blob) {
  if (!blob || !blob.length) return null;
  try {
    const decoded = Unarchiver.open(Buffer.from(blob), Unarchiver.BinaryDecoding.decodable).decodeAll();
    const s = findString(decoded);
    return s === null ? null : s.replace(/￼/g, "").trim();
  } catch {
    return null;
  }
}

/** 5-6 digit senders: banks, deliveries, 2FA. The server skips them too; this keeps them on the Mac. */
export function isShortCode(handle) {
  return typeof handle === "string" && /^\d{5,6}$/.test(handle.replace(/[\s-]/g, ""));
}

const OTP_DIGITS = /(?<![\d.,$])\d{4,8}(?![\d.,])/;
const OTP_WORDS = /\b(code|codes|verification|verify|otp|passcode|pass code|one[- ]time|2fa|security code|login code|sign[- ]in code)\b/i;

/** Same rule as the server (server/messages/redact.ts): codes never leave the Mac. */
export function isOneTimeCode(text) {
  return !!text && OTP_DIGITS.test(text) && OTP_WORDS.test(text);
}

/**
 * Copies chat.db and its -wal/-shm into a fresh temp dir (so Messages.app is never locked or
 * written to) and opens the copy read-only (?mode=ro). Returns { db, dir }; close both with closeCopy.
 */
export function openChatDbCopy(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strout-imessage-"));
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, "chat.db");
  fs.copyFileSync(source, target);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(`file:${target}?mode=ro`, { readOnly: true });
  return { db, dir };
}

export function closeCopy(copy) {
  try {
    copy.db.close();
  } finally {
    fs.rmSync(copy.dir, { recursive: true, force: true });
  }
}

function columns(db, table) {
  return new Set(db.prepare(`pragma table_info(${table})`).all().map((c) => c.name));
}

/**
 * Messages with ROWID > afterRowId, oldest first, at most `limit`. Each comes back with what the
 * server needs and a `skip` reason when the collector should not send it (a tapback/reaction,
 * a group event, a short-code sender, a one-time code, or nothing to send).
 */
export function readMessages(db, afterRowId, limit) {
  const cols = columns(db, "message");
  const opt = (name, fallback = "0") => (cols.has(name) ? `m.${name}` : fallback);
  // `date` holds nanoseconds (~8e17), beyond a JS number: read integers as BigInt here.
  const stmt = db.prepare(
    `select m.ROWID as rowid, m.guid, m.text, m.attributedBody as attributed_body, m.date, m.is_from_me, m.service,
            ${opt("item_type")} as item_type, ${opt("associated_message_type")} as associated_message_type,
            ${opt("cache_has_attachments")} as has_attachments,
            h.id as handle, c.ROWID as chat_rowid, c.guid as chat_guid, c.display_name as chat_name, c.chat_identifier
       from message m
       join chat_message_join cmj on cmj.message_id = m.ROWID
       join chat c on c.ROWID = cmj.chat_id
       left join handle h on h.ROWID = m.handle_id
      where m.ROWID > ?
      order by m.ROWID
      limit ?`,
  );
  stmt.setReadBigInts(true);
  const rows = stmt.all(afterRowId, limit);
  const members = db.prepare(`select h.id from chat_handle_join chj join handle h on h.ROWID = chj.handle_id where chj.chat_id = ? order by h.id`);
  const atts = db.prepare(
    `select a.transfer_name, a.filename, a.mime_type, a.total_bytes from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id where maj.message_id = ?`,
  );
  const memberCache = new Map();
  const out = [];
  for (const r of rows) {
    const chatRowId = Number(r.chat_rowid);
    if (!memberCache.has(chatRowId)) memberCache.set(chatRowId, members.all(chatRowId).map((x) => x.id));
    const text = r.text ?? decodeAttributedBody(r.attributed_body);
    const fromMe = Number(r.is_from_me) === 1;
    const attachments = Number(r.has_attachments)
      ? atts.all(Number(r.rowid)).map((a) => ({ filename: a.transfer_name ?? (a.filename ? path.basename(a.filename) : null), mime: a.mime_type ?? null, size: a.total_bytes == null ? null : Number(a.total_bytes) }))
      : [];
    let skip = null;
    if (Number(r.associated_message_type) !== 0) skip = "reaction";
    else if (Number(r.item_type) !== 0) skip = "system";
    else if (!fromMe && isShortCode(r.handle)) skip = "short_code";
    else if (isOneTimeCode(text)) skip = "one_time_code";
    else if (!(text && text.trim()) && !attachments.length) skip = "empty";
    const sentAt = appleTimeToDate(r.date);
    if (!sentAt && !skip) skip = "no_date";
    out.push({
      rowid: Number(r.rowid),
      skip,
      chatLabel: r.chat_name || r.chat_identifier || r.chat_guid,
      message: skip
        ? null
        : {
            guid: r.guid,
            chat_guid: r.chat_guid,
            chat_name: r.chat_name || null,
            chat_participants: memberCache.get(chatRowId),
            service: r.service ?? null,
            sent_at: sentAt.toISOString(),
            is_from_me: fromMe,
            handle: fromMe ? null : r.handle ?? null,
            text: text ?? "",
            attachments,
          },
    });
  }
  return out;
}

export function defaultPaths(home = os.homedir()) {
  return {
    chatDb: path.join(home, "Library/Messages/chat.db"),
    state: path.join(home, ".strout-vault/imessage-state.json"),
    token: path.join(home, ".strout-vault/imessage-token"),
  };
}

export function readState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return { lastRowId: Number.isInteger(v.last_rowid) ? v.last_rowid : 0 };
  } catch {
    return { lastRowId: 0 };
  }
}

export function writeState(file, lastRowId) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ last_rowid: lastRowId, updated_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
