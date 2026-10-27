// Synthetic copies of the Apple databases the Mac media collector reads: Voice Memos'
// CloudRecordings.db with its .m4a files, and Notes' NoteStore.sqlite with a "Call Recordings"
// folder whose audio lives under Accounts/<account>/Media/<media id>/<generation>/. The tables and
// columns follow what macOS 14/15 write (and, with `legacy`, the older column names); the content is
// made up (555 numbers, example names). Used by the collector tests and docs/ingest-verification.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encodeNoteBody, loadSqlite, toCoreData } from "../../../collectors/apple-media/lib.mjs";

/** True when this Node has node:sqlite (22.13+); the collector needs it, the vault does not. */
export const SQLITE_AVAILABLE = (() => {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
})();

export interface AppleFixture {
  root: string;
  voiceMemosDir: string;
  notesDir: string;
  files: string[];
}

function tone(file: string, freq: number, seconds: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-c:a", "aac", file]);
}

const at = (iso: string) => toCoreData(new Date(iso));

export const LONG_NOTE = "Woodlands porch: cedar shutters, board and batten, 14 pairs. Ask Gulf Coast for cypress pricing before Friday.";
export const PRIVATE_NOTE = "Private thoughts that must never leave the Mac, however long this note happens to be.";

export function buildAppleFixtures(root: string, opts: { legacy?: boolean; broken?: boolean } = {}): AppleFixture {
  const { DatabaseSync } = loadSqlite();
  fs.rmSync(root, { recursive: true, force: true });
  const voiceMemosDir = path.join(root, "group.com.apple.VoiceMemos.shared/Recordings");
  const notesDir = path.join(root, "group.com.apple.notes");
  fs.mkdirSync(voiceMemosDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const files: string[] = [];

  // ---- Voice Memos ----
  tone(path.join(voiceMemosDir, "20261020 091500-A1B2C3D4.m4a"), 440, 6);
  tone(path.join(voiceMemosDir, "20261020 101500-SHORT000.m4a"), 500, 2);
  tone(path.join(voiceMemosDir, "20261019 080000-DELETED0.m4a"), 550, 6);
  files.push(...fs.readdirSync(voiceMemosDir).map((f) => path.join(voiceMemosDir, f)));
  const vm = new DatabaseSync(path.join(voiceMemosDir, "CloudRecordings.db"));
  vm.exec(`create table ZCLOUDRECORDING (Z_PK integer primary key, Z_ENT integer, Z_OPT integer, ZFLAGS integer, ZDATE timestamp, ZDURATION float,
             ZEVICTIONDATE timestamp, ZCUSTOMLABEL varchar, ZCUSTOMLABELFORSORTING varchar, ZENCRYPTEDTITLE varchar, ZPATH varchar, ZUNIQUEID varchar, ZFOLDER integer)`);
  vm.exec(`create table ZFOLDER (Z_PK integer primary key, ZENCRYPTEDNAME varchar, ZUUID varchar)`);
  const insVm = vm.prepare(`insert into ZCLOUDRECORDING (ZFLAGS, ZDATE, ZDURATION, ZEVICTIONDATE, ZCUSTOMLABEL, ZENCRYPTEDTITLE, ZPATH, ZUNIQUEID) values (0, ?, ?, ?, ?, ?, ?, ?)`);
  insVm.run(at("2026-10-20T14:15:00Z"), 6.0, null, "Porch idea", "Porch idea", "20261020 091500-A1B2C3D4.m4a", "A1B2C3D4-0000-4000-8000-000000000001");
  insVm.run(at("2026-10-20T15:15:00Z"), 2.0, null, null, "New Recording 2", "20261020 101500-SHORT000.m4a", "A1B2C3D4-0000-4000-8000-000000000002");
  insVm.run(at("2026-10-19T13:00:00Z"), 6.0, at("2026-10-21T00:00:00Z"), null, "Old idea", "20261019 080000-DELETED0.m4a", "A1B2C3D4-0000-4000-8000-000000000003");
  insVm.run(at("2026-10-18T13:00:00Z"), 30.0, null, null, "In iCloud only", "20261018 080000-CLOUD000.m4a", "A1B2C3D4-0000-4000-8000-000000000004");
  vm.close();

  // ---- Notes ----
  const accountId = "6F1C7E1A-0000-4000-8000-ACC000000001";
  const callMedia = "MEDIA-CALL-0001";
  const call2Media = "MEDIA-CALL-0002";
  const otherMedia = "MEDIA-OTHER-0001";
  const call3Media = "MEDIA-CALL-0003";
  tone(path.join(notesDir, "Accounts", accountId, "Media", callMedia, "1_7A2B", "Call with Kevin McGuire.m4a"), 660, 8);
  tone(path.join(notesDir, "Accounts", accountId, "Media", call2Media, "1_9C3D", "Call.m4a"), 700, 5);
  tone(path.join(notesDir, "Accounts", accountId, "Media", otherMedia, "Audio.m4a"), 900, 3);
  tone(path.join(notesDir, "Accounts", accountId, "Media", call3Media, "1_4E5F", "Call Recording.m4a"), 740, 5);
  for (const d of [callMedia, call2Media, otherMedia, call3Media]) {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    files.push(...walk(path.join(notesDir, "Accounts", accountId, "Media", d)));
  }
  const ns = new DatabaseSync(path.join(notesDir, "NoteStore.sqlite"));
  const title = opts.legacy ? "ZTITLE" : "ZTITLE1";
  const created = opts.legacy ? "ZCREATIONDATE1" : "ZCREATIONDATE3";
  const uti = opts.broken ? "ZTYPEUTI_RENAMED" : "ZTYPEUTI";
  ns.exec(`create table ZICCLOUDSYNCINGOBJECT (Z_PK integer primary key, Z_ENT integer, Z_OPT integer, ZIDENTIFIER varchar, ZNAME varchar,
             ${title} varchar, ZTITLE2 varchar, ZFOLDER integer, ZFOLDERTYPE integer, ${created} timestamp, ZMODIFICATIONDATE1 timestamp,
             ZISPASSWORDPROTECTED integer, ZMARKEDFORDELETION integer, ZACCOUNT3 integer, ZACCOUNT4 integer, ${uti} varchar, ZNOTE integer,
             ZMEDIA integer, ZFILENAME varchar, ZDURATION float, ZADDITIONALINDEXABLETEXT varchar, ZNOTEDATA integer)`);
  ns.exec(`create table ZICNOTEDATA (Z_PK integer primary key, Z_ENT integer, Z_OPT integer, ZNOTE integer, ZDATA blob, ZCRYPTOTAG blob)`);
  ns.exec(`create table Z_PRIMARYKEY (Z_ENT integer primary key, Z_NAME varchar, Z_SUPER integer, Z_MAX integer)`);
  const obj = ns.prepare(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, ZIDENTIFIER, ZNAME, ${title}, ZTITLE2, ZFOLDER, ZFOLDERTYPE, ${created}, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZMARKEDFORDELETION, ZACCOUNT3, ${uti}, ZNOTE, ZMEDIA, ZFILENAME, ZDURATION, ZADDITIONALINDEXABLETEXT)
                          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const data = ns.prepare(`insert into ZICNOTEDATA (ZNOTE, ZDATA) values (?, ?)`);
  // account and folders
  obj.run(1, accountId, "iCloud", null, null, null, null, null, null, 0, 0, null, null, null, null, null, null, null);
  const folder = (pk: number, name: string, type = 0) => obj.run(pk, `FOLDER-${pk}`, null, null, name, null, type, null, null, 0, 0, 1, null, null, null, null, null, null);
  folder(2, "Notes");
  folder(3, "Private");
  folder(4, "Call Recordings");
  folder(5, "Recently Deleted", 1);
  folder(6, "Another Story");
  const note = (pk: number, id: string, t: string, folderPk: number, body: string, o: { createdAt?: string; modifiedAt?: string; locked?: boolean; deleted?: boolean } = {}) => {
    obj.run(pk, id, null, t, null, folderPk, null, at(o.createdAt ?? "2026-10-20T16:00:00Z"), at(o.modifiedAt ?? o.createdAt ?? "2026-10-20T16:00:00Z"), o.locked ? 1 : 0, o.deleted ? 1 : 0, 1, null, null, null, null, null, null);
    data.run(pk, encodeNoteBody(body));
  };
  note(10, "NOTE-0010-LONG", "Woodlands porch", 2, `Woodlands porch\n${LONG_NOTE}￼`);
  note(11, "NOTE-0011-PRIV", "Private", 3, PRIVATE_NOTE);
  note(12, "NOTE-0012-SHRT", "Milk", 2, "Milk, eggs");
  note(13, "NOTE-0013-LOCK", "Locked", 2, "Locked note body that is long enough to be sent otherwise.", { locked: true });
  note(14, "NOTE-0014-TRSH", "Trashed", 5, "A deleted note that is long enough to be sent otherwise, but is in the trash.");
  note(15, "NOTE-0015-CALL", "Call with Kevin McGuire", 4, "Call with Kevin McGuire\nKevin: The drone pass has to happen before nine.\nBen: Then we start at sunrise.\n￼", { createdAt: "2026-10-21T15:04:05Z" });
  note(16, "NOTE-0016-CALL", "+1 (214) 555-0166", 4, "+1 (214) 555-0166\n￼", { createdAt: "2026-10-21T18:30:00Z" });
  note(17, "NOTE-0017-AUDI", "Shoot day voice note", 6, "Shoot day voice note with an audio attachment and enough words to be sent as a note.￼");
  // Where iOS files a call when there is no Call Recordings folder: the main Notes folder, titled "Call Recording".
  note(18, "NOTE-0018-CALL", "Call Recording", 2, "Call Recording\n\uFFFC", { createdAt: "2026-10-22T13:10:00Z" });
  // attachments (audio) and their media rows
  const attach = (pk: number, id: string, notePk: number, mediaPk: number, duration: number, transcript: string | null) =>
    obj.run(pk, id, null, null, null, null, null, null, null, 0, 0, null, "com.apple.m4a-audio", notePk, mediaPk, null, duration, transcript);
  const media = (pk: number, id: string, file: string) => obj.run(pk, id, null, null, null, null, null, null, null, 0, 0, 1, null, null, null, file, null, null);
  media(100, callMedia, "Call with Kevin McGuire.m4a");
  media(101, call2Media, "Call.m4a");
  media(102, otherMedia, "Audio.m4a");
  media(103, call3Media, "Call Recording.m4a");
  attach(200, "ATT-0200-CALL", 15, 100, 8, "Kevin: The drone pass has to happen before nine. Ben: Then we start at sunrise.");
  attach(201, "ATT-0201-CALL", 16, 101, 5, null);
  attach(202, "ATT-0202-AUDI", 17, 102, 3, null);
  attach(203, "ATT-0203-CALL", 18, 103, 5, null);
  ns.close();
  files.push(path.join(voiceMemosDir, "CloudRecordings.db"), path.join(notesDir, "NoteStore.sqlite"));
  return { root, voiceMemosDir, notesDir, files: files.sort() };
}
