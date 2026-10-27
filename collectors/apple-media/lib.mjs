// The Apple media collector's pure parts: finding and opening Apple's databases read-only,
// --discover, reading Voice Memos and Notes (call recordings and text notes), the minimal note
// body decoder, filters, state, the Keychain token and the rotating log. No network here, and no
// note text, transcript or title is ever logged: collector.mjs prints counts and ids only.
//
// Schemas are read, never assumed: every query names its columns from `pragma table_info`, and a
// table without the columns the extractor needs stops the run with a SchemaError that lists what is
// missing (run --discover and send the output). Nothing in the Apple containers is ever modified:
// each database (plus -wal/-shm) is copied to a private temp dir, the copy is opened ?mode=ro and
// deleted afterwards, and media files are only ever opened for reading.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

/** node:sqlite (Node 22.13+), loaded only when a database is opened. */
export function loadSqlite() {
  return createRequire(import.meta.url)("node:sqlite");
}

/** Seconds between the Unix epoch and Apple's Core Data epoch (2001-01-01T00:00:00Z). */
export const APPLE_EPOCH_OFFSET_SEC = 978307200;

/** Core Data timestamps are seconds (a double) since 2001-01-01. Null for 0 / missing. */
export function coreDataDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return new Date((n + APPLE_EPOCH_OFFSET_SEC) * 1000);
}

export function toCoreData(date) {
  return date.getTime() / 1000 - APPLE_EPOCH_OFFSET_SEC;
}

export class SchemaError extends Error {}
export class AccessError extends Error {}

export const FULL_DISK_ACCESS_HELP = [
  "macOS is refusing to let this node binary read the Notes / Voice Memos containers: it needs Full Disk Access.",
  "  1. Find the real node binary:   realpath \"$(which node)\"",
  "  2. System Settings → Privacy & Security → Full Disk Access → + → ⌘⇧G, paste that path → Open, switch it on.",
  "  3. Run this command again. (The iMessage collector's grant is the same binary: if it works, this works.)",
].join("\n");

export function defaultPaths(home = os.homedir()) {
  const gc = path.join(home, "Library/Group Containers");
  return {
    voiceMemosDirs: [
      path.join(gc, "group.com.apple.VoiceMemos.shared/Recordings"),
      path.join(home, "Library/Application Support/com.apple.voicememos/Recordings"),
    ],
    notesDir: path.join(gc, "group.com.apple.notes"),
    state: path.join(home, ".strout-vault/apple-media-state.json"),
    config: path.join(home, ".strout-vault/apple-media.json"),
    log: path.join(home, "Library/Logs/strout-vault-apple-media.log"),
  };
}

export const DEFAULT_CONFIG = {
  include_voice_memos: true,
  include_call_recordings: true,
  include_notes: true,
  /** Notes folders never sent (case-insensitive). */
  skip_folders: ["Private"],
  /** When set, only these Notes folders are sent (call recordings are not affected). */
  allow_folders: null,
  /** The Notes folder iOS saves call recordings in (when it makes one). */
  call_recordings_folder: "Call Recordings",
  /**
   * Also treat a note as a call recording, in any folder, when it has audio and its title starts
   * with "Call" ("Call with Kevin McGuire", "Call Recording"): where iOS files them when there is no
   * Call Recordings folder.
   */
  call_title_detection: true,
  /** Notes shorter than this (characters, after trimming) are not sent. */
  min_note_chars: 40,
  /** Voice memos shorter than this are not sent. */
  min_memo_seconds: 5,
};

export function loadConfig(file) {
  let user = {};
  if (file && fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
  }
  const out = { ...DEFAULT_CONFIG, ...user };
  for (const k of Object.keys(user)) if (!(k in DEFAULT_CONFIG)) throw new Error(`${file}: unknown setting "${k}"`);
  if (!Array.isArray(out.skip_folders)) throw new Error("skip_folders must be a list");
  if (out.allow_folders !== null && !Array.isArray(out.allow_folders)) throw new Error("allow_folders must be a list or null");
  return out;
}

/** Throws AccessError (with the Full Disk Access fix) when macOS refuses the directory; false when it does not exist. */
export function canRead(dir) {
  try {
    fs.readdirSync(dir);
    return true;
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES") throw new AccessError(`${dir}: permission denied.\n${FULL_DISK_ACCESS_HELP}`);
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw err;
  }
}

/**
 * Copies a SQLite database and its -wal/-shm into a fresh private temp dir and opens the copy
 * read-only. The original is never opened. Returns { db, dir }; close with closeCopy.
 */
export function openCopy(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strout-apple-media-"));
  fs.chmodSync(dir, 0o700);
  const target = path.join(dir, path.basename(source));
  try {
    fs.copyFileSync(source, target);
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err.code === "EPERM" || err.code === "EACCES") throw new AccessError(`${source}: permission denied.\n${FULL_DISK_ACCESS_HELP}`);
    throw err;
  }
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

export function tables(db) {
  return db.prepare(`select name from sqlite_master where type = 'table' order by name`).all().map((r) => r.name);
}

export function columns(db, table) {
  return db.prepare(`pragma table_info(${JSON.stringify(table)})`).all().map((c) => c.name);
}

/** The first of `candidates` that `cols` has, or null. */
function pick(cols, candidates) {
  return candidates.find((c) => cols.includes(c)) ?? null;
}

function requireColumns(table, cols, needed) {
  const missing = needed.filter((n) => (Array.isArray(n) ? !n.some((x) => cols.includes(x)) : !cols.includes(n))).map((n) => (Array.isArray(n) ? n.join(" | ") : n));
  if (missing.length) throw new SchemaError(`${table} does not have the columns the extractor needs: ${missing.join(", ")}. Run --discover and send its output.`);
}

// ---------------------------------------------------------------- Voice Memos --

const VM_NEEDED = ["ZUNIQUEID", "ZDATE", "ZDURATION", "ZPATH"];

/** The Voice Memos directory that holds CloudRecordings.db, or null. */
export function findVoiceMemosDir(dirs) {
  for (const d of dirs) if (canRead(d) && fs.existsSync(path.join(d, "CloudRecordings.db"))) return d;
  return null;
}

/**
 * Every voice memo: { uniqueId, title, recordedAt, durationSec, file, bytes, skip }.
 * skip: deleted (in Recently Deleted), short, not_downloaded (iCloud has not brought the file down yet).
 */
export function readVoiceMemos(db, recordingsDir, cfg = DEFAULT_CONFIG) {
  if (!tables(db).includes("ZCLOUDRECORDING")) throw new SchemaError("CloudRecordings.db has no ZCLOUDRECORDING table. Run --discover and send its output.");
  const cols = columns(db, "ZCLOUDRECORDING");
  requireColumns("ZCLOUDRECORDING", cols, VM_NEEDED);
  const titleCols = ["ZCUSTOMLABELFORSORTING", "ZCUSTOMLABEL", "ZENCRYPTEDTITLE"].filter((c) => cols.includes(c));
  const evicted = pick(cols, ["ZEVICTIONDATE"]);
  const rows = db
    .prepare(
      `select ZUNIQUEID as uid, ZDATE as date, ZDURATION as duration, ZPATH as path,
              ${titleCols.length ? `coalesce(${titleCols.map((c) => `nullif(${c}, '')`).join(", ")})` : "null"} as title,
              ${evicted ? evicted : "null"} as evicted
         from ZCLOUDRECORDING order by ZDATE`,
    )
    .all();
  return rows.map((r) => {
    const rel = String(r.path ?? "");
    const file = rel ? (path.isAbsolute(rel) ? rel : path.join(recordingsDir, rel)) : null;
    let bytes = null;
    if (file) {
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = null;
      }
    }
    const durationSec = Number(r.duration ?? 0);
    let skip = null;
    if (r.evicted) skip = "deleted";
    else if (durationSec < cfg.min_memo_seconds) skip = "short";
    else if (!file || bytes === null || bytes === 0) skip = "not_downloaded";
    return {
      uniqueId: String(r.uid),
      title: r.title ? String(r.title) : null,
      recordedAt: coreDataDate(r.date),
      durationSec,
      file,
      bytes,
      skip,
    };
  });
}

// ---------------------------------------------------------------------- Notes --

const AUDIO_UTIS = ["com.apple.m4a-audio", "public.mpeg-4-audio", "public.audio", "com.apple.coreaudio-format", "public.mp3", "com.microsoft.waveform-audio", "public.aac-audio", "com.apple.quicktime-audio"];
const AUDIO_EXT = [".m4a", ".caf", ".mp3", ".wav", ".aac", ".mp4", ".qta"];

/** Reads one protobuf varint at `pos`. */
function varint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}

/** The fields of one protobuf message: [{ field, wire, value }] with length-delimited values as Buffers. */
export function protoFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      let v;
      [v, pos] = varint(buf, pos);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error("truncated field");
      out.push({ field, wire, value: buf.subarray(pos, end) });
      pos = end;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/**
 * The plain text of a note body (ZICNOTEDATA.ZDATA): gzip, then the NoteStoreProto path
 * document(2) -> note(3) -> note_text(2). Only that path is decoded; formatting runs, tables and
 * drawings are ignored. Attachment placeholders (U+FFFC) are removed. Null when it is not a note body.
 */
export function decodeNoteBody(blob) {
  if (!blob || !blob.length) return null;
  let raw;
  try {
    raw = zlib.gunzipSync(Buffer.from(blob));
  } catch {
    return null;
  }
  try {
    const doc = protoFields(raw).find((f) => f.field === 2 && f.wire === 2);
    if (!doc) return null;
    const note = protoFields(doc.value).find((f) => f.field === 3 && f.wire === 2);
    if (!note) return null;
    const text = protoFields(note.value).find((f) => f.field === 2 && f.wire === 2);
    if (!text) return null;
    return text.value.toString("utf8").replace(/￼/g, "").replace(/\u0000/g, "");
  } catch {
    return null;
  }
}

/** Builds a gzipped note body for fixtures: the inverse of decodeNoteBody. */
export function encodeNoteBody(text) {
  const len = (n) => {
    const out = [];
    let v = n;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return Buffer.from(out);
  };
  const field = (num, payload) => Buffer.concat([Buffer.from([(num << 3) | 2]), len(payload.length), payload]);
  const noteText = field(2, Buffer.from(text, "utf8"));
  const note = field(3, noteText);
  const document = field(2, Buffer.concat([Buffer.from([0x10, 0x00]), note]));
  return zlib.gzipSync(Buffer.concat([Buffer.from([0x08, 0x00]), document]));
}

const NOTES_NEEDED = ["Z_PK", "ZIDENTIFIER", ["ZTITLE1", "ZTITLE"], "ZFOLDER", "ZTITLE2", "ZTYPEUTI", "ZNOTE", "ZMEDIA"];

/**
 * Reads NoteStore.sqlite. Returns { notes, recordings, folders } where
 *   notes:      { id, title, folder, createdAt, modifiedAt, text, skip }   (text-only notes)
 *   recordings: { ref, noteId, attachmentId, title, folder, createdAt, durationSec, file, bytes,
 *                 participant, appleTranscript, skip }   (audio in the call recordings folder)
 * skip reasons: locked, deleted, folder_skipped, folder_not_allowed, short, empty,
 * not_downloaded. Audio in other folders is counted (other_audio) and not sent.
 */
export function readNotes(db, notesDir, cfg = DEFAULT_CONFIG) {
  const t = tables(db);
  for (const need of ["ZICCLOUDSYNCINGOBJECT", "ZICNOTEDATA"]) if (!t.includes(need)) throw new SchemaError(`NoteStore.sqlite has no ${need} table. Run --discover and send its output.`);
  const cols = columns(db, "ZICCLOUDSYNCINGOBJECT");
  requireColumns("ZICCLOUDSYNCINGOBJECT", cols, NOTES_NEEDED);
  const dataCols = columns(db, "ZICNOTEDATA");
  requireColumns("ZICNOTEDATA", dataCols, ["ZNOTE", "ZDATA"]);
  const title = pick(cols, ["ZTITLE1", "ZTITLE"]);
  const created = pick(cols, ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE"]);
  const modified = pick(cols, ["ZMODIFICATIONDATE1", "ZMODIFICATIONDATE"]);
  const locked = pick(cols, ["ZISPASSWORDPROTECTED"]);
  const deleted = pick(cols, ["ZMARKEDFORDELETION"]);
  const folderType = pick(cols, ["ZFOLDERTYPE"]);
  const duration = pick(cols, ["ZDURATION"]);
  const indexable = pick(cols, ["ZADDITIONALINDEXABLETEXT"]);
  const filename = pick(cols, ["ZFILENAME"]);
  const accountCols = cols.filter((c) => /^ZACCOUNT\d*$/.test(c));

  const folders = new Map();
  for (const f of db.prepare(`select Z_PK as pk, ZTITLE2 as title, ${folderType ?? "0"} as type from ZICCLOUDSYNCINGOBJECT where ZTITLE2 is not null`).all()) {
    folders.set(Number(f.pk), { title: String(f.title), trash: Number(f.type) === 1 || /^recently deleted$/i.test(String(f.title)) });
  }
  const accounts = new Map();
  if (cols.includes("ZNAME")) {
    for (const a of db.prepare(`select Z_PK as pk, ZIDENTIFIER as id from ZICCLOUDSYNCINGOBJECT where ZNAME is not null and ZIDENTIFIER is not null`).all()) accounts.set(Number(a.pk), String(a.id));
  }

  const noteRows = db
    .prepare(
      `select n.Z_PK as pk, n.ZIDENTIFIER as id, n.${title} as title, n.ZFOLDER as folder,
              ${created ? `n.${created}` : "null"} as created, ${modified ? `n.${modified}` : "null"} as modified,
              ${locked ? `n.${locked}` : "0"} as locked, ${deleted ? `n.${deleted}` : "0"} as deleted,
              ${accountCols.length ? `coalesce(${accountCols.map((c) => `n.${c}`).join(", ")})` : "null"} as account,
              d.ZDATA as data
         from ZICCLOUDSYNCINGOBJECT n join ZICNOTEDATA d on d.ZNOTE = n.Z_PK
        order by n.Z_PK`,
    )
    .all();
  const attachments = db
    .prepare(
      `select a.Z_PK as pk, a.ZIDENTIFIER as id, a.ZTYPEUTI as uti, a.ZNOTE as note, a.ZMEDIA as media,
              ${duration ? `a.${duration}` : "null"} as duration, ${indexable ? `a.${indexable}` : "null"} as indexable,
              m.ZIDENTIFIER as media_id, ${filename ? "m.ZFILENAME" : "null"} as media_file
         from ZICCLOUDSYNCINGOBJECT a left join ZICCLOUDSYNCINGOBJECT m on m.Z_PK = a.ZMEDIA
        where a.ZNOTE is not null and a.ZTYPEUTI is not null
        order by a.Z_PK`,
    )
    .all();
  const audioByNote = new Map();
  for (const a of attachments) {
    const uti = String(a.uti);
    const isAudio = AUDIO_UTIS.includes(uti) || /audio/i.test(uti) || AUDIO_EXT.includes(path.extname(String(a.media_file ?? "")).toLowerCase());
    if (!isAudio) continue;
    const list = audioByNote.get(Number(a.note)) ?? [];
    list.push(a);
    audioByNote.set(Number(a.note), list);
  }

  const lower = (s) => String(s ?? "").trim().toLowerCase();
  const callFolder = lower(cfg.call_recordings_folder);
  const skipFolders = new Set(cfg.skip_folders.map(lower));
  const allowFolders = cfg.allow_folders ? new Set(cfg.allow_folders.map(lower)) : null;
  const notes = [];
  const recordings = [];
  let otherAudio = 0;
  let duplicateCopies = 0;
  for (const n of noteRows) {
    const folder = folders.get(Number(n.folder)) ?? null;
    const folderTitle = folder?.title ?? null;
    const base = {
      id: String(n.id),
      title: n.title ? String(n.title) : null,
      folder: folderTitle,
      createdAt: coreDataDate(n.created) ?? coreDataDate(n.modified),
      modifiedAt: coreDataDate(n.modified) ?? coreDataDate(n.created),
    };
    const gone = Number(n.deleted) === 1 || folder?.trash;
    const audio = audioByNote.get(Number(n.pk)) ?? [];
    const isCall = audio.length > 0 && (lower(folderTitle) === callFolder || (cfg.call_title_detection !== false && CALL_TITLE.test(String(base.title ?? ""))));
    if (isCall) {
      const text = decodeNoteBody(n.data);
      // iOS keeps each call twice: the raw "moments_…-audio.MOV" (which carries the duration) and the
      // exported "Call with ….m4a". Send the export once per call, with its twin's duration.
      const raw = audio.filter((a) => MOMENTS_FILE.test(String(a.media_file ?? "")));
      const exported = audio.filter((a) => !MOMENTS_FILE.test(String(a.media_file ?? "")));
      const calls = exported.length && raw.length ? exported : audio;
      duplicateCopies += audio.length - calls.length;
      calls.forEach((a, i) => {
        if (!(Number(a.duration) > 0) && calls === exported && raw[i] && Number(raw[i].duration) > 0) a.duration = raw[i].duration;
      });
      for (const a of calls) {
        const file = findMediaFile(notesDir, accounts.get(Number(n.account)) ?? null, a.media_id ? String(a.media_id) : null, a.media_file ? String(a.media_file) : null);
        let bytes = null;
        if (file) bytes = fs.statSync(file).size;
        let skip = null;
        if (Number(n.locked) === 1) skip = "locked";
        else if (gone) skip = "deleted";
        else if (!file || !bytes) skip = "not_downloaded";
        recordings.push({
          ref: `notes:${base.id}:${a.id}`,
          noteId: base.id,
          attachmentId: String(a.id),
          title: base.title,
          folder: folderTitle,
          createdAt: base.createdAt,
          durationSec: a.duration == null ? null : Number(a.duration),
          file,
          bytes,
          participant: participantFromTitle(base.title),
          appleTranscript: appleTranscript(a.indexable, text),
          skip,
        });
      }
      continue;
    }
    if (audio.length) otherAudio += audio.length;
    let skip = null;
    let text = null;
    if (Number(n.locked) === 1) skip = "locked";
    else if (gone) skip = "deleted";
    else if (folderTitle && skipFolders.has(lower(folderTitle))) skip = "folder_skipped";
    else if (allowFolders && !allowFolders.has(lower(folderTitle))) skip = "folder_not_allowed";
    else {
      text = decodeNoteBody(n.data);
      if (text === null || !text.trim()) skip = "empty";
      else if (text.trim().length < cfg.min_note_chars) skip = "short";
    }
    notes.push({ ...base, text: skip ? null : text.trim(), skip });
  }
  return { notes, recordings, otherAudio, duplicateCopies, folders: [...folders.values()].map((f) => f.title) };
}

/** Apple's own transcript of a call recording, when the note carries one (kept for comparison only). */
function appleTranscript(indexable, noteText) {
  const s = indexable ? String(indexable).trim() : "";
  if (s.length >= 20) return s;
  const t = (noteText ?? "").trim();
  // A call-recording note's body is the transcript when Apple wrote one; a bare title is not.
  return t.split("\n").length > 2 && t.length >= 40 ? t : null;
}

const PHONE = /^\+?[\d\s().-]{7,20}$/;
/** The raw copy iOS keeps of every recorded call, next to the exported "Call with ….m4a". */
export const MOMENTS_FILE = /^moments_.*-audio\.mov$/i;
/** iOS's call-recording note titles: "Call with Kevin McGuire", "Call Recording", "Call". */
export const CALL_TITLE = /^\s*call(\s+(with|recording)\b|\s*$)/i;

/** "Call with Kevin McGuire", "Kevin McGuire", "+1 (936) 555-0142" -> { name, phone }. */
export function participantFromTitle(title) {
  if (!title) return null;
  let s = String(title).trim();
  s = s.replace(/^(call recording|recorded call|phone call|call)\s*(with|from|to)?\s*[:\-–]?\s*/i, "").replace(/\s*[·•|,–-]\s*\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?.*$/, "").trim();
  if (!s) return null;
  if (PHONE.test(s) && s.replace(/\D/g, "").length >= 7) return { name: null, phone: s };
  return { name: s.slice(0, 200), phone: null };
}

/**
 * Where an attachment's file lives: Accounts/<account>/Media/<media id>/[<generation>/]<filename>.
 * The generation folder exists on newer macOS only, so the media folder is searched (two levels).
 */
export function findMediaFile(notesDir, accountId, mediaId, filename) {
  if (!mediaId) return null;
  const roots = [];
  const accountsDir = path.join(notesDir, "Accounts");
  if (accountId) roots.push(path.join(accountsDir, accountId, "Media", mediaId));
  try {
    for (const a of fs.readdirSync(accountsDir)) {
      const p = path.join(accountsDir, a, "Media", mediaId);
      if (!roots.includes(p)) roots.push(p);
    }
  } catch {
    /* no Accounts dir */
  }
  roots.push(path.join(notesDir, "Media", mediaId));
  for (const root of roots) {
    const hit = searchFile(root, filename, 2);
    if (hit) return hit;
  }
  return null;
}

function searchFile(dir, filename, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && ((filename && e.name === filename) || (!filename && AUDIO_EXT.includes(path.extname(e.name).toLowerCase())))) return path.join(dir, e.name);
  }
  if (depth > 0) for (const e of entries) if (e.isDirectory()) {
    const hit = searchFile(path.join(dir, e.name), filename, depth - 1);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------- discover --

/**
 * What is really on this Mac: paths, whether they are readable, every table, the columns of the
 * tables the extractor reads, row counts, Notes folder names with note counts (to write the filter
 * config), audio attachment UTIs, and whether the extractor's required columns are present.
 * Never note text, titles of notes, or transcripts.
 */
export function discover(paths = defaultPaths()) {
  const lines = [];
  const say = (s = "") => lines.push(s);
  say(`strout-vault apple-media --discover  (${new Date().toISOString()}, macOS ${osVersion()}, node ${process.version})`);
  say();
  say("Voice Memos");
  for (const d of paths.voiceMemosDirs) {
    let state;
    try {
      state = canRead(d) ? "readable" : "not found";
    } catch (err) {
      state = err instanceof AccessError ? "PERMISSION DENIED (Full Disk Access)" : err.message;
    }
    say(`  ${d}: ${state}`);
    const dbPath = path.join(d, "CloudRecordings.db");
    if (state !== "readable" || !fs.existsSync(dbPath)) continue;
    const files = fs.readdirSync(d).filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()));
    say(`    audio files in folder: ${files.length}`);
    describeDb(dbPath, ["ZCLOUDRECORDING", "ZFOLDER"], say, (db) => {
      try {
        const memos = readVoiceMemos(db, d, { ...DEFAULT_CONFIG, min_memo_seconds: 0 });
        const by = countBy(memos.map((m) => m.skip ?? "ok"));
        say(`    extractor: OK (${memos.length} recording(s): ${fmtCounts(by)})`);
      } catch (err) {
        say(`    extractor: ${err instanceof SchemaError ? "SCHEMA MISMATCH: " : "ERROR: "}${err.message}`);
      }
    });
  }
  say();
  say("Notes (call recordings + text notes)");
  let notesState;
  try {
    notesState = canRead(paths.notesDir) ? "readable" : "not found";
  } catch (err) {
    notesState = err instanceof AccessError ? "PERMISSION DENIED (Full Disk Access)" : err.message;
  }
  say(`  ${paths.notesDir}: ${notesState}`);
  const store = path.join(paths.notesDir, "NoteStore.sqlite");
  if (notesState === "readable" && fs.existsSync(store)) {
    let accounts = [];
    try {
      accounts = fs.readdirSync(path.join(paths.notesDir, "Accounts"));
    } catch {
      /* none */
    }
    say(`    Accounts/: ${accounts.length} account folder(s)${accounts.length ? `: ${accounts.join(", ")}` : ""}`);
    describeDb(store, ["ZICCLOUDSYNCINGOBJECT", "ZICNOTEDATA"], say, (db) => {
      const cols = columns(db, "ZICCLOUDSYNCINGOBJECT");
      if (cols.includes("ZTYPEUTI")) {
        const utis = db.prepare(`select ZTYPEUTI as uti, count(*) as n from ZICCLOUDSYNCINGOBJECT where ZTYPEUTI is not null group by ZTYPEUTI order by n desc`).all();
        say(`    attachment types: ${utis.map((u) => `${u.uti} ${u.n}`).join(", ") || "none"}`);
      }
      try {
        const r = readNotes(db, paths.notesDir, { ...DEFAULT_CONFIG, min_note_chars: 0, skip_folders: [] });
        const callNotes = [...new Map(r.recordings.map((c) => [c.noteId, c.folder])).values()];
        const perFolder = countBy([...r.notes.map((n) => n.folder ?? "(no folder)"), ...callNotes.map((f) => f ?? "(no folder)")]);
        say(`    folders (notes per folder; use these names in ~/.strout-vault/apple-media.json):`);
        for (const [f, n] of Object.entries(perFolder).sort((a, b) => b[1] - a[1])) say(`      ${f}: ${n}`);
        say(`    extractor: OK (${r.notes.length} text note(s): ${fmtCounts(countBy(r.notes.map((n) => n.skip ?? "ok")))}; ${r.recordings.length} call recording(s) (folder "${DEFAULT_CONFIG.call_recordings_folder}" or a title starting "Call"): ${fmtCounts(countBy(r.recordings.map((n) => n.skip ?? "ok")))}, ${r.duplicateCopies} duplicate copies skipped; ${r.otherAudio} other audio attachment(s), not sent)`);
      } catch (err) {
        say(`    extractor: ${err instanceof SchemaError ? "SCHEMA MISMATCH: " : "ERROR: "}${err.message}`);
      }
    });
  }
  return lines.join("\n");
}

function describeDb(file, interesting, say, extra) {
  let copy;
  try {
    copy = openCopy(file);
  } catch (err) {
    say(`    ${path.basename(file)}: cannot open (${err.message.split("\n")[0]})`);
    return;
  }
  try {
    const all = tables(copy.db);
    say(`    ${path.basename(file)}: ${all.length} table(s): ${all.join(", ")}`);
    for (const t of interesting) {
      if (!all.includes(t)) {
        say(`    ${t}: MISSING`);
        continue;
      }
      const n = copy.db.prepare(`select count(*) as n from ${t}`).get().n;
      say(`    ${t} (${n} row(s)): ${columns(copy.db, t).join(", ")}`);
    }
    extra(copy.db);
  } finally {
    closeCopy(copy);
  }
}

function osVersion() {
  try {
    return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

export function countBy(list) {
  const out = {};
  for (const k of list) out[k] = (out[k] ?? 0) + 1;
  return out;
}

export function fmtCounts(obj) {
  return Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
}

// ------------------------------------------------------------- files, state --

export async function sha256File(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

/** { started_at, voice_memo: { <ref>: <sha> }, iphone_call: { <ref>: <sha> }, apple_note: { <ref>: <modified ISO> } } */
export function readState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return { started_at: v.started_at ?? null, voice_memo: v.voice_memo ?? {}, iphone_call: v.iphone_call ?? {}, apple_note: v.apple_note ?? {} };
  } catch {
    return { started_at: null, voice_memo: {}, iphone_call: {}, apple_note: {} };
  }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updated_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The ingest:device token: STROUT_VAULT_TOKEN, else the macOS Keychain (service strout-vault, account apple-media). */
export function readToken(opts = {}) {
  if (process.env.STROUT_VAULT_TOKEN) return process.env.STROUT_VAULT_TOKEN.trim();
  try {
    return execFileSync("security", ["find-generic-password", "-s", opts.service ?? "strout-vault", "-a", opts.account ?? "apple-media", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Appends lines to `file`, rotating at `maxBytes` (file.1 .. file.<keep>). Counts and ids only reach it. */
export function makeLogger(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const keep = opts.keep ?? 3;
  const echo = opts.echo ?? true;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    const stamped = `[apple-media ${new Date().toISOString()}] ${line}`;
    if (echo) console.log(stamped);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, stamped + "\n", { mode: 0o600 });
    } catch {
      /* logging must never stop a run */
    }
  };
}
