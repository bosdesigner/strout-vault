// A synthetic ~/Library/Messages/chat.db: the tables and columns the collector reads, filled with
// made-up conversations (555 numbers, example.com addresses). Never real messages. Used by the
// collector tests and by docs/messages-verification (the dry run output).
import fs from "node:fs";
import { dateToAppleNanos, loadSqlite } from "../../../collectors/imessage/lib.mjs";

/** True when this Node has node:sqlite (22.13+); the collector needs it, the vault does not. */
export const SQLITE_AVAILABLE = (() => {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
})();

/** Encodes an integer the way Apple's typedstream does (1 byte, or 0x81 + int16 LE, or 0x82 + int32 LE). */
function tsInt(n: number): Buffer {
  if (n >= 0 && n <= 0x7f) return Buffer.from([n]);
  if (n <= 0x7fff) {
    const b = Buffer.alloc(3);
    b[0] = 0x81;
    b.writeInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x82;
  b.writeInt32LE(n, 1);
  return b;
}

/**
 * An NSAttributedString archived as a typedstream, byte for byte the shape Messages.app writes to
 * message.attributedBody (one attribute run, __kIMMessagePartAttributeName = 0).
 */
export function attributedBody(text: string): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  const head = Buffer.from(
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b",
    "hex",
  );
  const mid = Buffer.from("8684026949", "hex");
  const tail = Buffer.from(
    "928484840c4e5344696374696f6e61727900948401690192849696" + "1d5f5f6b494d4d657373616765506172744174747269627574654e616d658692848484084e534e756d626572008484074e5356616c7565009484012a84999900868686",
    "hex",
  );
  return Buffer.concat([head, tsInt(utf8.length), utf8, mid, tsInt(1), tsInt(text.length), tail]);
}

export interface FixtureMessage {
  guid: string;
  chat: string;
  handle: string | null;
  fromMe?: boolean;
  at: string;
  text?: string | null;
  /** Store the body only in attributedBody (text column null), like newer macOS. */
  attributed?: boolean;
  associatedType?: number;
  itemType?: number;
  attachments?: Array<{ transfer_name: string; mime_type: string; total_bytes: number }>;
}

export interface FixtureChat {
  guid: string;
  identifier: string;
  name?: string | null;
  members: string[];
}

export const FIXTURE_CHATS: FixtureChat[] = [
  { guid: "iMessage;-;+19365550142", identifier: "+19365550142", members: ["+19365550142"] },
  { guid: "SMS;-;(205) 555-0142", identifier: "(205) 555-0142", members: ["(205) 555-0142"] },
  { guid: "iMessage;-;205.555.0142", identifier: "205.555.0142", members: ["205.555.0142"] },
  { guid: "iMessage;-;+12055550142", identifier: "+12055550142", members: ["+12055550142"] },
  { guid: "iMessage;-;+12145550166", identifier: "+12145550166", members: ["+12145550166"] },
  { guid: "iMessage;-;+15125550111", identifier: "+15125550111", members: ["+15125550111"] },
  { guid: "SMS;-;48291", identifier: "48291", members: ["48291"] },
  { guid: "iMessage;-;+17135550199", identifier: "+17135550199", members: ["+17135550199"] },
  { guid: "chat-group-0001", identifier: "chat0001", name: "Conroe crew", members: ["+19365550142", "+15125550177"] },
];

export const FIXTURE_MESSAGES: FixtureMessage[] = [
  // Kevin McGuire (seed party 2, another_story), two Chicago days; the second day's body lives only in attributedBody.
  { guid: "fx-k-1", chat: "iMessage;-;+19365550142", handle: "+19365550142", at: "2026-10-20T14:05:00Z", text: "Conroe shoot is moved to Thursday, the client wants golden hour" },
  { guid: "fx-k-2", chat: "iMessage;-;+19365550142", handle: null, fromMe: true, at: "2026-10-20T14:07:30Z", text: "Works for me. Can you bring the drone?" },
  { guid: "fx-k-3", chat: "iMessage;-;+19365550142", handle: "+19365550142", at: "2026-10-20T14:09:00Z", text: "Yes, batteries charged", associatedType: 0 },
  { guid: "fx-k-4", chat: "iMessage;-;+19365550142", handle: null, fromMe: true, at: "2026-10-20T14:10:00Z", text: 'Loved "Yes, batteries charged"', associatedType: 2000 },
  { guid: "fx-k-5", chat: "iMessage;-;+19365550142", handle: "+19365550142", at: "2026-10-21T04:30:00Z", text: "Sent the Conroe shot list ✅", attributed: true },
  // 10:30 pm on Oct 21 in Chicago is 03:30 UTC on Oct 22: still Oct 21 locally.
  { guid: "fx-k-6", chat: "iMessage;-;+19365550142", handle: null, fromMe: true, at: "2026-10-22T03:30:00Z", text: "Thanks, looks great", attributed: true },
  { guid: "fx-k-7", chat: "iMessage;-;+19365550142", handle: "+19365550142", at: "2026-10-21T15:00:00Z", text: "Photo from the site", attachments: [{ transfer_name: "IMG_0412.HEIC", mime_type: "image/heic", total_bytes: 2_481_337 }] },
  // One person, three spellings of the same number.
  { guid: "fx-p-1", chat: "SMS;-;(205) 555-0142", handle: "(205) 555-0142", at: "2026-10-20T16:00:00Z", text: "Hi Ben, this is Alex from the lumber yard" },
  { guid: "fx-p-2", chat: "iMessage;-;205.555.0142", handle: "205.555.0142", at: "2026-10-20T16:01:00Z", text: "Trusses ship Monday" },
  { guid: "fx-p-3", chat: "iMessage;-;+12055550142", handle: "+12055550142", at: "2026-10-20T16:02:00Z", text: "Invoice to follow" },
  // Daniel (phalanx partner, given a phone in the tests).
  { guid: "fx-x-1", chat: "iMessage;-;+12145550166", handle: "+12145550166", at: "2026-10-20T18:00:00Z", text: "Phalanx term sheet redlines are in the data room" },
  // Family (routed to personal by a rule).
  { guid: "fx-f-1", chat: "iMessage;-;+15125550111", handle: "+15125550111", at: "2026-10-20T23:00:00Z", text: "Dinner Sunday at 6?" },
  // Never stored: a short code, a verification code, sensitive numbers get redacted.
  { guid: "fx-s-1", chat: "SMS;-;48291", handle: "48291", at: "2026-10-20T12:00:00Z", text: "Your package was delivered" },
  { guid: "fx-o-1", chat: "iMessage;-;+17135550199", handle: "+17135550199", at: "2026-10-20T12:01:00Z", text: "Your code is 482913" },
  { guid: "fx-r-1", chat: "iMessage;-;+17135550199", handle: "+17135550199", at: "2026-10-20T12:02:00Z", text: "Card 4111 1111 1111 1111 exp 04/29, my SSN is 123-45-6789" },
  // A group chat with an unknown member.
  { guid: "fx-g-1", chat: "chat-group-0001", handle: "+15125550177", at: "2026-10-20T20:00:00Z", text: "Who has the slider for Conroe?" },
  { guid: "fx-g-2", chat: "chat-group-0001", handle: "+19365550142", at: "2026-10-20T20:01:00Z", text: "I do" },
  { guid: "fx-g-3", chat: "chat-group-0001", handle: null, at: "2026-10-20T20:02:00Z", text: "Kevin named the conversation", itemType: 2 },
];

/** Writes a synthetic chat.db at `file` (replacing it). */
export function buildChatDb(file: string, messages: FixtureMessage[] = FIXTURE_MESSAGES, chats: FixtureChat[] = FIXTURE_CHATS): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec(`
    create table handle (ROWID integer primary key autoincrement, id text not null, service text not null default 'iMessage', unique (id, service));
    create table chat (ROWID integer primary key autoincrement, guid text unique not null, chat_identifier text, display_name text, service_name text);
    create table message (ROWID integer primary key autoincrement, guid text unique not null, text text, attributedBody blob, handle_id integer default 0,
      service text, date integer, is_from_me integer default 0, item_type integer default 0, associated_message_type integer default 0, cache_has_attachments integer default 0);
    create table chat_message_join (chat_id integer, message_id integer, message_date integer default 0, primary key (chat_id, message_id));
    create table chat_handle_join (chat_id integer, handle_id integer, unique (chat_id, handle_id));
    create table attachment (ROWID integer primary key autoincrement, guid text unique not null, filename text, mime_type text, transfer_name text, total_bytes integer default 0);
    create table message_attachment_join (message_id integer, attachment_id integer, unique (message_id, attachment_id));
  `);
  const handleId = new Map<string, number>();
  const addHandle = (id: string) => {
    if (!handleId.has(id)) {
      const r = db.prepare(`insert into handle (id) values (?)`).run(id);
      handleId.set(id, Number(r.lastInsertRowid));
    }
    return handleId.get(id)!;
  };
  const chatId = new Map<string, number>();
  for (const c of chats) {
    const r = db.prepare(`insert into chat (guid, chat_identifier, display_name, service_name) values (?, ?, ?, ?)`).run(c.guid, c.identifier, c.name ?? null, c.guid.startsWith("SMS") ? "SMS" : "iMessage");
    chatId.set(c.guid, Number(r.lastInsertRowid));
    for (const m of c.members) db.prepare(`insert into chat_handle_join (chat_id, handle_id) values (?, ?)`).run(Number(r.lastInsertRowid), addHandle(m));
  }
  let att = 0;
  for (const m of messages) {
    const attributed = m.attributed && m.text ? attributedBody(m.text) : null;
    const r = db
      .prepare(
        `insert into message (guid, text, attributedBody, handle_id, service, date, is_from_me, item_type, associated_message_type, cache_has_attachments) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.guid,
        m.attributed ? null : m.text ?? null,
        attributed,
        m.handle ? addHandle(m.handle) : 0,
        m.chat.startsWith("SMS") ? "SMS" : "iMessage",
        dateToAppleNanos(new Date(m.at)),
        m.fromMe ? 1 : 0,
        m.itemType ?? 0,
        m.associatedType ?? 0,
        m.attachments?.length ? 1 : 0,
      );
    const mid = Number(r.lastInsertRowid);
    db.prepare(`insert into chat_message_join (chat_id, message_id) values (?, ?)`).run(chatId.get(m.chat)!, mid);
    for (const a of m.attachments ?? []) {
      const ar = db.prepare(`insert into attachment (guid, filename, mime_type, transfer_name, total_bytes) values (?, ?, ?, ?, ?)`).run(`att-${++att}`, `~/Library/Messages/Attachments/xx/${a.transfer_name}`, a.mime_type, a.transfer_name, a.total_bytes);
      db.prepare(`insert into message_attachment_join (message_id, attachment_id) values (?, ?)`).run(mid, Number(ar.lastInsertRowid));
    }
  }
  db.close();
}
