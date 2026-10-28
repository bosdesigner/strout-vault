// Pure helpers for the TikTok DM collector (no browser, no network): turning TikTok's time labels
// into dates, telling which messages in an open conversation are new since the last run, giving
// them stable ids, and building the batch for POST /api/ingest/social. Unit-tested in
// tests/unit/tiktok-collector.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultPaths(home = os.homedir()) {
  const dir = path.join(home, ".strout-vault");
  return {
    dir,
    token: path.join(dir, "tiktok-token"),
    state: path.join(dir, "tiktok-state.json"),
    profile: path.join(dir, "tiktok-profile"),
    selectors: path.join(dir, "tiktok-selectors.json"),
    failures: path.join(dir, "tiktok-failures"),
  };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function setClock(d, h, m, ampm) {
  let hour = Number(h);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  d.setHours(hour, Number(m ?? 0), 0, 0);
  return d;
}

/**
 * A TikTok inbox time label as a Date in the Mac's local time, or null when it is not one.
 * Handles "3:05 PM", "15:05", "Today 3:05 PM", "Yesterday 15:05", "Monday 3:05 PM",
 * "10/26/2026 3:05 PM", "10-26-2026", "2026-10-26 15:05", "Oct 26, 2026 3:05 PM", "Oct 26 3:05 PM",
 * and the list's relative ages "5m", "2h", "3d", "1w" ("5 minutes ago").
 */
export function parseTikTokTime(label, now = new Date()) {
  const s = String(label ?? "").trim().replace(/\s+/g, " ").replace(/ /g, " ");
  if (!s) return null;
  const clockRe = /(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i;
  const clock = clockRe.exec(s);
  const withClock = (d) => (clock ? setClock(d, clock[1], clock[2], clock[3]) : (d.setHours(12, 0, 0, 0), d));

  const rel = /^(\d+)\s*(s|sec|m|min|h|hr|d|w)\w*(\s+ago)?$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("s") ? 1e3 : unit.startsWith("m") ? 60e3 : unit.startsWith("h") ? 3600e3 : unit === "d" ? 86400e3 : 7 * 86400e3;
    return new Date(now.getTime() - n * ms);
  }
  if (/^just now$/i.test(s)) return new Date(now);

  const lower = s.toLowerCase();
  if (lower.startsWith("today")) return withClock(new Date(now));
  if (lower.startsWith("yesterday")) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return withClock(d);
  }
  const wd = WEEKDAYS.findIndex((w) => lower.startsWith(w) || lower.startsWith(w.slice(0, 3) + " "));
  if (wd >= 0) {
    const d = new Date(now);
    let back = (d.getDay() - wd + 7) % 7;
    if (back === 0) back = 7;
    d.setDate(d.getDate() - back);
    return withClock(d);
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return withClock(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return withClock(new Date(y, Number(m[1]) - 1, Number(m[2])));
  }
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    const d = withClock(new Date(y, MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])));
    if (!m[3] && d.getTime() > now.getTime() + 86400e3) d.setFullYear(--y);
    return d;
  }
  m = /^(\d{1,2})[-/](\d{1,2})(?:\s|$)/.exec(s);
  if (m) {
    const d = withClock(new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2])));
    if (d.getTime() > now.getTime() + 86400e3) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  if (clock && clockRe.exec(s)?.index === 0) return withClock(new Date(now));
  return null;
}

/** sha1 of the parts, hex, short: stable ids and fingerprints that carry no message text. */
export function digest(...parts) {
  return crypto.createHash("sha1").update(parts.map((p) => String(p ?? "")).join("\u0001")).digest("hex").slice(0, 20);
}

/** What identifies a message on screen when TikTok shows no id: who wrote it and what it says. */
export function fingerprint(m) {
  return digest(m.from_me ? "me" : "them", (m.text ?? "").trim(), m.shared_url ?? "", (m.attachments ?? []).length);
}

/**
 * The messages on screen that were not there last run. `seen` is the fingerprint sequence stored
 * for this conversation (oldest first, the last ones only). The newest stretch of what is on
 * screen that matches the end of `seen` is old; everything after it is new. With nothing seen,
 * everything on screen is new. When nothing on screen lines up with what was seen (TikTok showed
 * a different stretch), only messages whose fingerprints were never seen count as new.
 */
export function newMessages(onScreen, seen) {
  const fps = onScreen.map(fingerprint);
  if (!seen?.length) return { fresh: onScreen.map((m, i) => ({ m, fp: fps[i] })), aligned: true };
  // Longest k such that the last k seen fingerprints equal some window fps[j-k..j-1]; prefer the latest j.
  let bestEnd = -1;
  let bestLen = 0;
  for (let end = fps.length; end >= 1; end--) {
    let k = 0;
    while (k < end && k < seen.length && fps[end - 1 - k] === seen[seen.length - 1 - k]) k++;
    if (k > bestLen) {
      bestLen = k;
      bestEnd = end;
    }
    if (bestLen >= Math.min(seen.length, 8)) break;
  }
  if (bestLen >= Math.min(2, seen.length, fps.length) && bestEnd >= 0) {
    return { fresh: onScreen.slice(bestEnd).map((m, i) => ({ m, fp: fps[bestEnd + i] })), aligned: true };
  }
  const known = new Set(seen);
  return { fresh: onScreen.map((m, i) => ({ m, fp: fps[i] })).filter((x) => !known.has(x.fp)), aligned: false };
}

export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: 1, conversations: {}, rows: {}, ...s };
  } catch {
    return { version: 1, conversations: {}, rows: {} };
  }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const KEEP_FINGERPRINTS = 60;

/**
 * Turns one opened conversation into the batch's conversation entry (or null when nothing is new)
 * and the conversation's next state. Message ids are "<conversation key>:<ordinal>", the ordinal
 * counting every message this collector ever sent for the conversation, so they never change.
 * A message's time is the time label above it; with none, the time this run first saw it.
 */
export function buildConversation(conv, prev, now = new Date()) {
  const { fresh, aligned } = newMessages(conv.messages, prev?.seen ?? []);
  let ordinal = prev?.ordinal ?? 0;
  const out = [];
  for (const { m, fp } of fresh) {
    const at = parseTikTokTime(m.time_label, now) ?? now;
    const sent = at.getTime() > now.getTime() + 5 * 60e3 ? now : at;
    ordinal++;
    out.push({
      id: `${conv.key}:${ordinal}`,
      sent_at: sent.toISOString(),
      from_me: !!m.from_me,
      text: m.text ?? "",
      ...(m.shared_url ? { shared_url: m.shared_url } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      _fp: fp,
    });
  }
  const seen = [...(prev?.seen ?? []), ...out.map((x) => x._fp)].slice(-KEEP_FINGERPRINTS);
  const next = { ordinal, seen, username: conv.username, updated_at: now.toISOString() };
  if (!out.length) return { entry: null, next, aligned };
  return {
    entry: {
      conversation_id: conv.key,
      peer: { username: conv.username, display_name: conv.nickname ?? null },
      ...(conv.is_request ? { is_request: true } : {}),
      messages: out.map(({ _fp, ...rest }) => rest),
    },
    next,
    aligned,
  };
}

/** A conversation key that survives TikTok reordering the list: the other person's username. */
export function conversationKey(username) {
  return `u-${String(username).toLowerCase().replace(/^@/, "")}`;
}

/** A list row as stored between runs: a digest of its preview and time, never the text. */
export function rowState(row, convKey, now = new Date()) {
  return { previewDigest: digest(row.preview ?? "", row.time_label ?? ""), conv: convKey, at: now.toISOString() };
}

/**
 * True when a list row changed since it was last opened (new message, unread badge, or never
 * opened). Rows are keyed by what the list shows (display name and avatar), since the username
 * is only visible once a conversation is open.
 */
export function listRowChanged(row, prev) {
  if (!prev) return true;
  if (row.unread) return true;
  return digest(row.preview ?? "", row.time_label ?? "") !== prev.previewDigest;
}
