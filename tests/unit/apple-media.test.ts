// The Mac media collector against fixture copies of each Apple database: Voice Memos'
// CloudRecordings.db and Notes' NoteStore.sqlite (current and older column names, and one with a
// renamed column that must fail loudly), the note body decoder, call-recording counterparties,
// filters, --discover, --dry-run, the rotating log, the Full Disk Access message, and proof that
// the Apple files are byte-for-byte unchanged after reading them.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AccessError,
  CALL_TITLE,
  canRead,
  closeCopy,
  coreDataDate,
  decodeNoteBody,
  DEFAULT_CONFIG,
  discover,
  encodeNoteBody,
  makeLogger,
  openCopy,
  participantFromTitle,
  readNotes,
  readVoiceMemos,
  SchemaError,
  toCoreData,
} from "../../collectors/apple-media/lib.mjs";
import { buildAppleFixtures, LONG_NOTE, PRIVATE_NOTE, SQLITE_AVAILABLE, type AppleFixture } from "../fixtures/apple-media/build.ts";
import { REPO_ROOT } from "../../scripts/lib/localdb.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-apple-"));
let fx: AppleFixture;
const sums = (files: string[]) => Object.fromEntries(files.map((f) => [path.relative(fx.root, f), crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("pure helpers", () => {
  it("Core Data timestamps", () => {
    const d = new Date("2026-10-20T14:15:00Z");
    expect(coreDataDate(toCoreData(d))?.toISOString()).toBe(d.toISOString());
    expect(coreDataDate(0)).toBeNull();
    expect(coreDataDate(null)).toBeNull();
  });

  it("decodes a gzipped NoteStoreProto body and nothing else", () => {
    const text = "Line one\nLine two with ünïcödé and an attachment ￼";
    expect(decodeNoteBody(encodeNoteBody(text))).toBe("Line one\nLine two with ünïcödé and an attachment ");
    expect(decodeNoteBody(Buffer.from("not gzip"))).toBeNull();
    expect(decodeNoteBody(null)).toBeNull();
  });

  it("reads a counterparty from a call recording's title", () => {
    expect(participantFromTitle("Call with Kevin McGuire")).toEqual({ name: "Kevin McGuire", phone: null });
    expect(participantFromTitle("+1 (214) 555-0166")).toEqual({ name: null, phone: "+1 (214) 555-0166" });
    expect(participantFromTitle("Call Recording – Daniel Ortiz")).toEqual({ name: "Daniel Ortiz", phone: null });
    expect(participantFromTitle("Call Recording")).toBeNull();
    expect(participantFromTitle("")).toBeNull();
    expect(CALL_TITLE.test("Call with Kevin McGuire")).toBe(true);
    expect(CALL_TITLE.test("Call Recording")).toBe(true);
    expect(CALL_TITLE.test("Call")).toBe(true);
    expect(CALL_TITLE.test("Call me back about cedar")).toBe(false);
    expect(CALL_TITLE.test("Callaway estimate")).toBe(false);
  });

  it("missing Full Disk Access is a clear error with the fix", () => {
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      expect(() => canRead("/Users/ben/Library/Group Containers/group.com.apple.notes")).toThrow(AccessError);
      expect(() => canRead("/x")).toThrow(/Full Disk Access/);
    } finally {
      spy.mockRestore();
    }
    expect(canRead(path.join(tmp, "does-not-exist"))).toBe(false);
  });

  it("the log rotates and keeps three", () => {
    const file = path.join(tmp, "logs/apple-media.log");
    const log = makeLogger(file, { maxBytes: 200, keep: 3, echo: false });
    for (let i = 0; i < 40; i++) log(`run ${i}: voice_memo created 1`);
    const names = fs.readdirSync(path.dirname(file)).sort();
    expect(names).toEqual(["apple-media.log", "apple-media.log.1", "apple-media.log.2", "apple-media.log.3"]);
    expect(fs.statSync(file).size).toBeLessThan(300);
  });
});

describe.skipIf(!SQLITE_AVAILABLE)("fixture databases", () => {
  beforeAll(() => {
    fx = buildAppleFixtures(path.join(tmp, "fixture"));
  });

  it("Voice Memos: title, date, duration, file; deleted, short and iCloud-only are skipped", () => {
    const before = sums(fx.files);
    const copy = openCopy(path.join(fx.voiceMemosDir, "CloudRecordings.db"));
    let memos;
    try {
      memos = readVoiceMemos(copy.db, fx.voiceMemosDir, DEFAULT_CONFIG);
    } finally {
      closeCopy(copy);
    }
    expect(fs.existsSync(copy.dir)).toBe(false);
    expect(memos.map((m) => [m.uniqueId.slice(-1), m.skip])).toEqual([
      ["4", "not_downloaded"],
      ["3", "deleted"],
      ["1", null],
      ["2", "short"],
    ]);
    const ok = memos.find((m) => !m.skip)!;
    expect(ok).toMatchObject({ title: "Porch idea", durationSec: 6 });
    expect(ok.recordedAt?.toISOString()).toBe("2026-10-20T14:15:00.000Z");
    expect(ok.file).toBe(path.join(fx.voiceMemosDir, "20261020 091500-A1B2C3D4.m4a"));
    expect(ok.bytes).toBe(fs.statSync(ok.file!).size);
    expect(sums(fx.files)).toEqual(before);
  });

  it("Notes: call recordings with counterparty, Apple's transcript and the file; text notes with filters", () => {
    const before = sums(fx.files);
    const copy = openCopy(path.join(fx.notesDir, "NoteStore.sqlite"));
    let r;
    try {
      r = readNotes(copy.db, fx.notesDir, DEFAULT_CONFIG);
    } finally {
      closeCopy(copy);
    }
    expect(r.recordings).toHaveLength(3);
    const kevin = r.recordings.find((c) => c.noteId === "NOTE-0015-CALL")!;
    expect(kevin).toMatchObject({ ref: "notes:NOTE-0015-CALL:ATT-0200-CALL", participant: { name: "Kevin McGuire", phone: null }, durationSec: 8, skip: null });
    expect(kevin.appleTranscript).toMatch(/drone pass/);
    expect(kevin.file).toBe(path.join(fx.notesDir, "Accounts/6F1C7E1A-0000-4000-8000-ACC000000001/Media/MEDIA-CALL-0001/1_7A2B/Call with Kevin McGuire.m4a"));
    expect(kevin.createdAt?.toISOString()).toBe("2026-10-21T15:04:05.000Z");
    const daniel = r.recordings.find((c) => c.noteId === "NOTE-0016-CALL")!;
    expect(daniel.participant).toEqual({ name: null, phone: "+1 (214) 555-0166" });
    expect(daniel.appleTranscript).toBeNull();
    // No Call Recordings folder: a "Call Recording" note with audio in the main Notes folder is a call too, with nobody named.
    const untitled = r.recordings.find((c) => c.noteId === "NOTE-0018-CALL")!;
    expect(untitled).toMatchObject({ folder: "Notes", participant: null, skip: null, ref: "notes:NOTE-0018-CALL:ATT-0203-CALL" });
    expect(Object.fromEntries(r.notes.map((n) => [n.id, n.skip]))).toEqual({
      "NOTE-0010-LONG": null,
      "NOTE-0011-PRIV": "folder_skipped",
      "NOTE-0012-SHRT": "short",
      "NOTE-0013-LOCK": "locked",
      "NOTE-0014-TRSH": "deleted",
      "NOTE-0017-AUDI": null,
    });
    const long = r.notes.find((n) => n.id === "NOTE-0010-LONG")!;
    expect(long.text).toBe(`Woodlands porch\n${LONG_NOTE}`);
    expect(long.folder).toBe("Notes");
    expect(r.notes.find((n) => n.id === "NOTE-0011-PRIV")!.text).toBeNull();
    expect(r.otherAudio).toBe(1);
    // Kevin's call is stored twice by iOS; it is sent once, as the exported .m4a, with the raw copy's duration.
    expect(r.duplicateCopies).toBe(1);
    expect(r.recordings.filter((c) => c.noteId === "NOTE-0015-CALL")).toHaveLength(1);
    expect(sums(fx.files)).toEqual(before);
  });

  it("allow_folders limits text notes; call recordings are unaffected", () => {
    const copy = openCopy(path.join(fx.notesDir, "NoteStore.sqlite"));
    try {
      const r = readNotes(copy.db, fx.notesDir, { ...DEFAULT_CONFIG, allow_folders: ["Another Story"] });
      expect(r.notes.filter((n) => !n.skip).map((n) => n.id)).toEqual(["NOTE-0017-AUDI"]);
      expect(r.recordings).toHaveLength(3);
    } finally {
      closeCopy(copy);
    }
  });

  it("older column names (ZTITLE, ZCREATIONDATE1) read the same", () => {
    const old = buildAppleFixtures(path.join(tmp, "legacy"), { legacy: true });
    const copy = openCopy(path.join(old.notesDir, "NoteStore.sqlite"));
    try {
      const r = readNotes(copy.db, old.notesDir, DEFAULT_CONFIG);
      expect(r.recordings).toHaveLength(3);
      expect(r.notes.find((n) => n.id === "NOTE-0010-LONG")?.title).toBe("Woodlands porch");
    } finally {
      closeCopy(copy);
    }
  });

  it("a schema that does not match fails with the missing column named, never silently", () => {
    const broken = buildAppleFixtures(path.join(tmp, "broken"), { broken: true });
    const copy = openCopy(path.join(broken.notesDir, "NoteStore.sqlite"));
    try {
      expect(() => readNotes(copy.db, broken.notesDir, DEFAULT_CONFIG)).toThrow(SchemaError);
      expect(() => readNotes(copy.db, broken.notesDir, DEFAULT_CONFIG)).toThrow(/ZTYPEUTI.*--discover/);
    } finally {
      closeCopy(copy);
    }
    const out = discover({ voiceMemosDirs: [broken.voiceMemosDir], notesDir: broken.notesDir, state: "", config: "", log: "" });
    expect(out).toContain("SCHEMA MISMATCH");
  });

  it("--discover prints paths, tables, columns, folder names and counts, never note text", () => {
    const before = sums(fx.files);
    const out = discover({ voiceMemosDirs: [fx.voiceMemosDir, path.join(tmp, "nope")], notesDir: fx.notesDir, state: "", config: "", log: "" });
    expect(out).toContain("ZCLOUDRECORDING (4 row(s)): Z_PK, Z_ENT");
    expect(out).toContain("ZICNOTEDATA");
    expect(out).toContain("Call Recordings: 2");
    expect(out).toContain("Notes: 4");
    expect(out).toContain("extractor: OK (4 recording(s)");
    expect(out).toMatch(/3 call recording\(s\) \(folder "Call Recordings" or a title starting "Call"\): ok 3, 1 duplicate copies skipped/);
    expect(out).toContain("com.apple.m4a-audio 4");
    expect(out).toContain("public.mpeg-4-audio 1");
    expect(out).toContain(`${path.join(tmp, "nope")}: not found`);
    for (const secret of [LONG_NOTE.slice(0, 30), PRIVATE_NOTE.slice(0, 30), "drone pass", "Porch idea"]) expect(out).not.toContain(secret);
    expect(sums(fx.files)).toEqual(before);
  });

  it("--dry-run counts and bytes per source, uploads nothing, leaves state and Apple files alone", () => {
    const before = sums(fx.files);
    const state = path.join(tmp, "state.json");
    const res = spawnSync(process.execPath, [
      path.join(REPO_ROOT, "collectors/apple-media/collector.mjs"),
      "--dry-run", "--backfill", "--voice-memos", fx.voiceMemosDir, "--notes", fx.notesDir, "--state", state, "--config", path.join(tmp, "no-config.json"),
    ], { encoding: "utf8", env: { ...process.env, STROUT_VAULT_URL: "http://127.0.0.1:9", STROUT_VAULT_TOKEN: "" } });
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    const memoBytes = fs.statSync(path.join(fx.voiceMemosDir, "20261020 091500-A1B2C3D4.m4a")).size;
    expect(out).toContain("DRY RUN: nothing was uploaded");
    expect(out).toMatch(new RegExp(`voice_memo\\s+1\\s+${memoBytes}\\s+0\\s+not_downloaded 1, deleted 1, short 1`));
    expect(out).toMatch(/iphone_call\s+3\s+\d+\s+0\s+none/);
    expect(out).toMatch(/apple_note\s+2\s+\d+\s+0\s+folder_skipped 1, short 1, locked 1, deleted 1/);
    expect(out).toContain("1 other audio attachment(s) in Notes, not call recordings, are never sent");
    expect(out).toContain("1 raw \"moments\" copies of call recordings skipped");
    for (const secret of [LONG_NOTE.slice(0, 30), PRIVATE_NOTE.slice(0, 30), "drone pass", "Porch idea", "Kevin"]) expect(out).not.toContain(secret);
    expect(fs.existsSync(state)).toBe(false);
    expect(sums(fx.files)).toEqual(before);
  });
});
