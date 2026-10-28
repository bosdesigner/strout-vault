// Social DMs without a database: handle identifiers, the dm_sources / handles config, grouping a
// batch into threads, the Instagram API's shapes, and the TikTok collector's pure logic and its
// in-page readers (against a stand-in of TikTok's inbox markup in happy-dom).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { handleDisplay, isOwner, normalizeHandle, normalizeIdentifier, ownerIdentity } from "../../server/messages/identity.ts";
import { parseBlocklist, parseRouting } from "../../server/messages/rules.ts";
import { skipReason, textThreadTitle } from "../../server/messages/ingest.ts";
import { emptyRules } from "../../server/messages/rules.ts";
import { socialBatchSchema, socialThreads } from "../../server/messages/social.ts";
import { igConversation, igTime } from "../../server/messages/instagram/sync.ts";
import { buildConversation, conversationKey, fingerprint, listRowChanged, newMessages, parseTikTokTime, readState, rowState, writeState, type ScreenMessage } from "../../collectors/tiktok/lib.mjs";
import { DEFAULT_SELECTORS, probePage, readConversation, readList } from "../../collectors/tiktok/page.mjs";
import { REPO_ROOT } from "../../scripts/lib/localdb.ts";

describe("handles", () => {
  it("normalise to <platform>:<username> and stay apart from phones and emails", () => {
    expect(normalizeHandle("tiktok", "@HeMakesBigMoves")).toBe("tiktok:hemakesbigmoves");
    expect(normalizeHandle("instagram", "kim.builds_atx")).toBe("instagram:kim.builds_atx");
    expect(normalizeHandle("myspace", "tom")).toBeNull();
    expect(normalizeHandle("tiktok", "has space")).toBeNull();
    expect(normalizeIdentifier("TikTok: @Mike")).toEqual({ kind: "handle", value: "tiktok:mike" });
    expect(normalizeIdentifier("tiktok:2055550142")).toEqual({ kind: "handle", value: "tiktok:2055550142" });
    expect(normalizeIdentifier("(205) 555-0142")?.kind).toBe("phone");
    expect(normalizeIdentifier("tiktok:bad handle!")?.kind).toBe("other");
    expect(handleDisplay("instagram:kim.builds")).toBe("@kim.builds");
  });

  it("Ben's own handles come from OWNER_HANDLES and connected accounts", () => {
    const owner = ownerIdentity({ OWNER_HANDLES: "tiktok:@HeMakesBigMoves, junk" }, [], ["instagram:anotherstory"]);
    expect([...owner.handles]).toEqual(["tiktok:hemakesbigmoves", "instagram:anotherstory"]);
    expect(isOwner(owner, normalizeIdentifier("tiktok:hemakesbigmoves"))).toBe(true);
    expect(isOwner(owner, normalizeIdentifier("tiktok:someoneelse"))).toBe(false);
  });

  it("config: dm_sources must name tiktok or instagram; blocklisted handles are normalised", () => {
    expect(parseRouting({ dm_sources: { TikTok: "another_story" } }).sources.get("tiktok")).toBe("another_story");
    expect(() => parseRouting({ dm_sources: { facebook: "another_story" } })).toThrow(/tiktok or instagram/);
    expect([...parseBlocklist({ handles: ["tiktok:@Spam.Bot", "not-a-handle"] }).handles]).toEqual(["tiktok:spam.bot"]);
  });

  it("a DM that is only a code is dropped; a longer one keeps its words", () => {
    const owner = ownerIdentity({});
    const m = (text: string) => ({ id: "x", sentAt: new Date(), fromMe: false, from: "tiktok:pegus", text });
    expect(skipReason(m("Your code is 771204"), { source: "tiktok", title: null }, owner, emptyRules())).toBe("one_time_code");
    expect(skipReason(m(`${"We used the 2021 IRC code 4812 for the stairs. ".repeat(5)}`), { source: "tiktok", title: null }, owner, emptyRules())).toBeNull();
    expect(textThreadTitle(null, ["Kim (@kim)"], "2026-10-27", "instagram")).toBe("Instagram DMs with Kim (@kim) · 2026-10-27");
  });
});

describe("social batches", () => {
  it("group per conversation per Chicago day, with prefixed message ids", () => {
    const batch = socialBatchSchema.parse({
      platform: "tiktok",
      account: "@HeMakesBigMoves",
      conversations: [
        {
          conversation_id: "c1",
          peer: { username: "@Mike", display_name: "Mike" },
          messages: [
            { id: "1", sent_at: "2026-10-27T04:30:00Z", from_me: false, text: "late" },
            { id: "2", sent_at: "2026-10-27T15:00:00Z", from_me: true, text: "morning" },
          ],
        },
      ],
    });
    const threads = socialThreads(batch);
    expect(threads.map((t) => t.sourceRef)).toEqual(["tiktok:hemakesbigmoves:c1:2026-10-26", "tiktok:hemakesbigmoves:c1:2026-10-27"]);
    expect(threads[0].messages[0]).toMatchObject({ id: "tiktok:1", from: "tiktok:mike", fromName: "Mike", fromMe: false });
    expect(threads[1].messages[0]).toMatchObject({ id: "tiktok:2", from: null, to: ["tiktok:mike"], fromMe: true });
  });
});

describe("Instagram API shapes", () => {
  it("reads both time formats", () => {
    expect(igTime("2022-07-12T19:11:07+0000")).toBe(Date.parse("2022-07-12T19:11:07Z"));
    expect(igTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(igTime("1700000000")).toBe(1_700_000_000_000);
    expect(Number.isNaN(igTime(undefined))).toBe(true);
  });

  it("finds the other person, Ben's side, shares and unsupported messages", () => {
    const me = { ids: new Set(["178"]), username: "anotherstory" };
    const peer = { id: "IG-1", username: "Kim.Builds" };
    const conv = igConversation(
      "c1",
      [
        { id: "a", created_time: "2026-10-27T14:00:00+0000", from: peer, to: { data: [{ id: "178", username: "anotherstory" }] }, message: "hi" },
        { id: "b", created_time: "2026-10-27T14:01:00+0000", from: { id: "178", username: "anotherstory" }, to: { data: [peer] }, message: "hey" },
        { id: "c", created_time: "2026-10-27T14:02:00+0000", from: peer, shares: { data: [{ link: "https://www.instagram.com/p/xyz/" }] } },
        { id: "d", created_time: "2026-10-27T14:03:00+0000", from: peer, is_unsupported: true },
      ],
      me,
    );
    expect(conv?.peer).toEqual({ username: "kim.builds", display_name: null, platform_id: "IG-1" });
    expect(conv?.messages.map((m) => [m.id, m.from_me, m.text, m.shared_url ?? null])).toEqual([
      ["a", false, "hi", null],
      ["b", true, "hey", null],
      ["c", false, "", "https://www.instagram.com/p/xyz/"],
      ["d", false, "[a message type the Instagram API does not show]", null],
    ]);
    expect(igConversation("c2", [{ id: "x", created_time: "2026-10-27T14:00:00+0000", from: { id: "178" }, message: "note" }], me)).toBeNull();
  });
});

describe("TikTok collector: time labels", () => {
  const now = new Date(2026, 9, 27, 20, 3); // Tue 27 Oct 2026, 8:03 pm local
  const at = (label: string) => parseTikTokTime(label, now);
  it.each([
    ["3:05 PM", new Date(2026, 9, 27, 15, 5)],
    ["15:05", new Date(2026, 9, 27, 15, 5)],
    ["Today 8:00 AM", new Date(2026, 9, 27, 8, 0)],
    ["Yesterday 11:59 PM", new Date(2026, 9, 26, 23, 59)],
    ["Monday 9:15 AM", new Date(2026, 9, 26, 9, 15)],
    ["Tue 9:15 AM", new Date(2026, 9, 20, 9, 15)],
    ["10/26/2026 10:00 AM", new Date(2026, 9, 26, 10, 0)],
    ["2026-10-01 07:30", new Date(2026, 9, 1, 7, 30)],
    ["Oct 2, 2026 1:00 PM", new Date(2026, 9, 2, 13, 0)],
    ["Dec 30 1:00 PM", new Date(2025, 11, 30, 13, 0)],
    ["2h", new Date(now.getTime() - 2 * 3600e3)],
    ["5 minutes ago", new Date(now.getTime() - 5 * 60e3)],
  ])("%s", (label, expected) => {
    expect(at(label)?.getTime()).toBe(expected.getTime());
  });
  it("is null for text that is not a time", () => {
    expect(at("See you Thursday.")).toBeNull();
    expect(at("")).toBeNull();
  });
});

describe("TikTok collector: what is new", () => {
  const m = (text: string, fromMe = false, time: string | null = null): ScreenMessage => ({ text, from_me: fromMe, time_label: time });
  const now = new Date(2026, 9, 27, 20, 0);

  it("first read takes everything; later reads take only what follows the last messages seen", () => {
    const first = buildConversation({ key: "u-mike", username: "mike", messages: [m("a", false, "Today 8:00 AM"), m("b", true)] }, undefined, now);
    expect(first.entry?.messages.map((x) => [x.id, x.text, x.from_me])).toEqual([
      ["u-mike:1", "a", false],
      ["u-mike:2", "b", true],
    ]);
    expect(first.entry?.messages[0].sent_at).toBe(new Date(2026, 9, 27, 8, 0).toISOString());
    expect(JSON.stringify(first.next)).not.toContain('"a"');

    // TikTok now shows a later window: b, then two new messages.
    const second = buildConversation({ key: "u-mike", username: "mike", messages: [m("b", true), m("c"), m("ok")] }, first.next, now);
    expect(second.entry?.messages.map((x) => [x.id, x.text])).toEqual([
      ["u-mike:3", "c"],
      ["u-mike:4", "ok"],
    ]);
    const third = buildConversation({ key: "u-mike", username: "mike", messages: [m("b", true), m("c"), m("ok")] }, second.next, now);
    expect(third.entry).toBeNull();
  });

  it("a repeated short message is still new when it follows what was seen", () => {
    const seen = [m("ok"), m("thanks", true)].map(fingerprint);
    expect(newMessages([m("ok"), m("thanks", true), m("ok")], seen).fresh.map((x) => x.m.text)).toEqual(["ok"]);
  });

  it("when nothing lines up, only never-seen messages count", () => {
    const seen = [m("x"), m("y"), m("z")].map(fingerprint);
    const r = newMessages([m("q"), m("y"), m("w")], seen);
    expect(r.aligned).toBe(false);
    expect(r.fresh.map((x) => x.m.text)).toEqual(["q", "w"]);
  });

  it("list rows are reopened only when their preview changes or they are unread", () => {
    const row = { index: 0, nickname: "Mike", preview: "See you", time_label: "2h", unread: false, avatar: "/a.jpeg" };
    const st = rowState(row, conversationKey("@Mike"));
    expect(st.conv).toBe("u-mike");
    expect(JSON.stringify(st)).not.toContain("See you");
    expect(listRowChanged(row, st)).toBe(false);
    expect(listRowChanged({ ...row, preview: "New one" }, st)).toBe(true);
    expect(listRowChanged({ ...row, unread: true }, st)).toBe(true);
    expect(listRowChanged(row, undefined)).toBe(true);
  });

  it("state is written privately and read back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-state-"));
    const file = path.join(dir, "s.json");
    writeState(file, { version: 1, conversations: { "u-a": { ordinal: 2, seen: ["f"], username: "a", updated_at: "x" } }, rows: {} });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readState(file).conversations["u-a"].ordinal).toBe(2);
    expect(readState(path.join(dir, "missing.json"))).toEqual({ version: 1, conversations: {}, rows: {} });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("TikTok collector: in-page readers", () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/tiktok/inbox.html"), "utf8");
  const inPage = <T>(fn: (...a: never[]) => T, ...args: unknown[]): T => {
    const win = new Window({ url: "https://www.tiktok.com/messages" });
    win.document.write(html);
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, location: g.location, window: g.window };
    Object.assign(g, { document: win.document, location: win.location, window: win });
    try {
      return (fn as (...a: unknown[]) => T)(...args);
    } finally {
      Object.assign(g, saved);
      void win.happyDOM.close();
    }
  };

  it("reads the conversation list without opening anything", () => {
    const rows = inPage(readList, DEFAULT_SELECTORS);
    expect(rows.map((r) => [r.nickname, r.preview, r.time_label, r.unread])).toEqual([
      ["🔥Mike Builds🔥", "See you Thursday.", "2h", true],
      ["Pegus Heard", "Can you add a second story?", "Yesterday", false],
    ]);
    expect(rows[0].avatar).toBe("/avatar/mike.jpeg");
  });

  it("reads the open conversation: who, whose side, time labels, shared videos", () => {
    const conv = inPage(readConversation, DEFAULT_SELECTORS, "HeMakesBigMoves");
    expect(conv.username).toBe("mikebuilds");
    expect(conv.nickname).toBe("🔥Mike Builds🔥");
    expect(conv.messages.map((x) => [x.from_me, x.text, x.time_label, x.shared_url ?? null])).toEqual([
      [false, "Saw the Build Up video. Is Huntsville open?", "10/26/2026 10:00 AM", null],
      [true, "It is. Grab a time on my calendar.", "10/26/2026 10:00 AM", null],
      [false, "", "Today 8:00 AM", "https://www.tiktok.com/@someoneelse/video/7400000000000000001"],
      [false, "Booked for Thursday.", "Today 8:00 AM", null],
    ]);
  });

  it("the probe reports structure and counts, never text", () => {
    const report = inPage(probePage, DEFAULT_SELECTORS);
    expect(report.counts).toMatchObject({ listItem: 2, messageItem: 4, timeDivider: 2, headerUsername: 1 });
    expect(report.dataE2e).toEqual(["chat-item", "chat-list-item", "chat-nickname", "chat-uniqueid"]);
    expect(JSON.stringify(report)).not.toMatch(/Huntsville|Booked|Pegus|Mike Builds/);
  });
});
