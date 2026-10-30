// Phase 1 v2, the pure parts: the content classifier (phalanx guard first), the title parser, due
// date resolution, name matching for people linking, the calendar and call-log pickers, and the
// connector scope defaults.
import { describe, expect, it } from "vitest";
import { decideWorkspace, phalanxTerms, type ClassifySignals, type LlmVerdict } from "../../server/workspaces/route.ts";
import { needsLlm } from "../../server/workspaces/classifyStep.ts";
import { firstLastKey, normalizeName, normalizeTitle, parseTitle } from "../../server/workspaces/titles.ts";
import { pickDueDate, resolveDueDate, validIsoDate } from "../../server/facts/dates.ts";
import { localCandidates, matchName, pickCalendarEvent } from "../../server/people/link.ts";
import { CONNECTOR_DEFAULT_RESTRICTED, RESTRICTED_WORKSPACES, resolveScope, scopeSql } from "../../server/mcp/scope.ts";
import { segmentIndexFor, STORED_KIND } from "../../server/worker/extract.ts";
import { matchCallLog } from "../../collectors/apple-media/lib.mjs";

const KNOWN = new Set(["another_story", "strout_arch", "phalanx", "southern_shutter", "sepp", "credvault", "personal", "inbox"]);
const none = { strong: [] as string[], weak: [] as string[] };
const sig = (over: Partial<ClassifySignals> = {}): ClassifySignals => ({
  interactionId: 1,
  kind: "meeting",
  title: "Ben Strout's Zoom Meeting",
  current: null,
  account: null,
  participants: [],
  titlePhalanx: none,
  phalanxLines: { strong: 0, weak: 0 },
  llm: null,
  ...over,
});
const llm = (workspace: string, confidence: number, phalanx_material = false): LlmVerdict => ({ workspace, confidence, reason: "test", phalanx_material });
const decide = (s: ClassifySignals) => decideWorkspace(s, { known: KNOWN }); // defaults: 0.6 to file, 0.8 for phalanx

describe("phalanx guard", () => {
  it("files to phalanx on a phalanx term in the title, whatever else points elsewhere", () => {
    const d = decide(sig({ title: "Shingle X investor sync", titlePhalanx: phalanxTerms("Shingle X investor sync"), account: "ben@anotherstory.com", llm: llm("another_story", 0.95) }));
    expect(d).toMatchObject({ workspaceId: "phalanx", phalanx: true, changed: true, review: null });
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("files to phalanx on two or more lines naming Phalanx, Dermatryx, Dermal X or Millpond", () => {
    for (const term of ["Phalanx", "Dermatryx", "Dermal X", "Millpond", "mill pond"]) {
      expect(phalanxTerms(`we talked about ${term} today`).strong.length, term).toBe(1);
    }
    expect(decide(sig({ phalanxLines: { strong: 2, weak: 0 } }))).toMatchObject({ workspaceId: "phalanx", phalanx: true });
  });

  it("leaves a single passing mention in inbox with a phalanx review item, never in another workspace", () => {
    const d = decide(sig({ phalanxLines: { strong: 1, weak: 0 }, llm: llm("another_story", 0.95) }));
    expect(d.workspaceId).toBe("inbox");
    expect(d.review).toMatchObject({ suggested: "phalanx" });
    expect(d.confidence).toBeLessThan(0.8);
  });

  it("files the passing mention to phalanx when Claude reads it as phalanx at 0.8+", () => {
    expect(decide(sig({ phalanxLines: { strong: 1, weak: 0 }, llm: llm("phalanx", 0.85) }))).toMatchObject({ workspaceId: "phalanx" });
  });

  it("treats wound care and cap-table material as phalanx-only: inbox unless Claude says phalanx", () => {
    for (const t of ["the wound care trial", "send me the cap table", "term sheet attached", "our pre-money valuation", "investor update for Q3"]) {
      expect(phalanxTerms(t).weak.length, t).toBeGreaterThan(0);
    }
    const borderline = decide(sig({ kind: "email_thread", account: "ben@anotherstory.com", phalanxLines: { strong: 0, weak: 1 }, llm: llm("another_story", 0.97) }));
    expect(borderline).toMatchObject({ workspaceId: "inbox", review: { suggested: "phalanx" } });
    expect(decide(sig({ phalanxLines: { strong: 0, weak: 3 }, llm: llm("phalanx", 0.9) }))).toMatchObject({ workspaceId: "phalanx" });
  });

  it("acts on Claude's phalanx_material flag even when it picked another workspace", () => {
    const d = decide(sig({ llm: llm("strout_arch", 0.9, true) }));
    expect(d).toMatchObject({ workspaceId: "inbox", phalanx: true, review: { suggested: "phalanx" } });
  });

  it("files to phalanx when every known participant is a phalanx-only contact", () => {
    const d = decide(sig({ kind: "text_thread", participants: [{ partyId: 9, name: "An Investor", workspaces: ["phalanx"] }] }));
    expect(d).toMatchObject({ workspaceId: "phalanx", phalanx: true });
  });

  it("moves an already-filed item out of a readable workspace when it is phalanx material", () => {
    const strong = decide(sig({ current: "another_story", phalanxLines: { strong: 3, weak: 0 } }));
    expect(strong).toMatchObject({ workspaceId: "phalanx", changed: true });
    const passing = decide(sig({ current: "another_story", phalanxLines: { strong: 1, weak: 0 } }));
    expect(passing).toMatchObject({ workspaceId: "inbox", changed: true, review: { suggested: "phalanx" } });
  });

  it("never touches what is already phalanx", () => {
    expect(decide(sig({ current: "phalanx", llm: llm("personal", 0.99) }))).toMatchObject({ workspaceId: "phalanx", changed: false });
  });

  it("does not fire on words that merely contain the terms", () => {
    expect(phalanxTerms("the phalange is broken").strong).toEqual([]);
    expect(phalanxTerms("shingles on the roof, a mill by the pond").strong).toEqual([]);
  });
});

describe("routing without phalanx signals", () => {
  it("files by Gmail mailbox: anotherstory -> another_story, stroutarch -> strout_arch, stroubo has no default", () => {
    expect(decide(sig({ kind: "email_thread", account: "ben@anotherstory.com" }))).toMatchObject({ workspaceId: "another_story", confidence: 0.9 });
    expect(decide(sig({ kind: "email_thread", account: "Ben@StroutArch.com" }))).toMatchObject({ workspaceId: "strout_arch" });
    expect(decide(sig({ kind: "email_thread", account: "stroubo@gmail.com" }))).toMatchObject({ workspaceId: "inbox" });
    expect(decide(sig({ kind: "email_thread", account: "stroubo@gmail.com", llm: llm("personal", 0.9) }))).toMatchObject({ workspaceId: "personal" });
  });

  it("files feasibility-study recordings to another_story, also when Claude says strout_arch for that reason", () => {
    expect(decide(sig({ title: "Lindsey Walters Feasibility Study Onboarding Meeting" }))).toMatchObject({ workspaceId: "another_story" });
    const d = decide(sig({ title: "Discovery call", llm: { workspace: "strout_arch", confidence: 0.9, reason: "a feasibility study discovery call", phalanx_material: false } }));
    expect(d.workspaceId).toBe("another_story");
  });

  it("files from participants when they agree on one workspace, more strongly with Claude agreeing", () => {
    const p = [{ partyId: 2, name: "Kevin", workspaces: ["another_story"] }];
    expect(decide(sig({ kind: "text_thread", participants: p }))).toMatchObject({ workspaceId: "another_story", confidence: 0.85 });
    expect(decide(sig({ kind: "text_thread", participants: p, llm: llm("another_story", 0.9) })).confidence).toBeGreaterThan(0.9);
  });

  it("sends participant/content disagreement to review when Claude is very sure", () => {
    const p = [{ partyId: 2, name: "Kevin", workspaces: ["another_story"] }];
    expect(decide(sig({ kind: "text_thread", current: "inbox", participants: p, llm: llm("personal", 0.95) }))).toMatchObject({ workspaceId: "inbox", changed: false, review: { suggested: "personal" } });
    expect(decide(sig({ kind: "text_thread", participants: p, llm: llm("personal", 0.8) }))).toMatchObject({ workspaceId: "another_story" });
  });

  it("files on Claude alone at 0.6+ (phalanx needs 0.8), and leaves anything less where it was (review from 0.4)", () => {
    expect(decide(sig({ kind: "note", current: "inbox", llm: llm("personal", 0.62) }))).toMatchObject({ workspaceId: "personal", changed: true });
    expect(decide(sig({ kind: "note", current: "inbox", llm: llm("another_story", 0.5) }))).toMatchObject({ workspaceId: "inbox", changed: false, review: { suggested: "another_story" } });
    expect(decide(sig({ kind: "note", current: "inbox", llm: llm("another_story", 0.3) }))).toMatchObject({ workspaceId: "inbox", review: null });
    expect(decide(sig({ kind: "note", current: "inbox" }))).toMatchObject({ workspaceId: "inbox", review: null, evidence: ["no signal"] });
    expect(decide(sig({ kind: "note", current: "inbox", llm: llm("phalanx", 0.7) }))).toMatchObject({ workspaceId: "inbox", review: { suggested: "phalanx" } });
  });

  it("leaves an unassigned Zoom meeting it cannot file unassigned (still readable as 'unassigned'), and filed items alone", () => {
    expect(decide(sig({ current: null }))).toMatchObject({ changed: false });
    expect(decide(sig({ current: null, llm: llm("another_story", 0.45) }))).toMatchObject({ changed: false, review: { suggested: "another_story" } });
    expect(decide(sig({ current: "strout_arch", llm: llm("personal", 0.99) }))).toMatchObject({ workspaceId: "strout_arch", changed: false });
    expect(decide(sig({ current: "inbox", humanFiled: true, llm: llm("personal", 0.99) }))).toMatchObject({ changed: false });
  });

  it("asks Claude only when the deterministic signals do not settle it", () => {
    const s1 = sig({ kind: "email_thread", account: "ben@anotherstory.com" });
    expect(needsLlm(decide(s1), s1, 0.8)).toBe(false);
    const s2 = sig({ kind: "note", current: "inbox" });
    expect(needsLlm(decide(s2), s2, 0.8)).toBe(true);
    const s3 = sig({ current: "another_story", phalanxLines: { strong: 1, weak: 0 } });
    expect(needsLlm(decide(s3), s3, 0.8)).toBe(true); // borderline phalanx gets a read
    const s4 = sig({ current: "another_story" });
    expect(needsLlm(decide(s4), s4, 0.8)).toBe(false);
  });
});

describe("title parser", () => {
  it.each([
    ["Ryan Meagher: AnotherStory Assessment", ["Ryan Meagher"], "AnotherStory Assessment"],
    ["Allan Lajeunesse : AnotherStory Assessment", ["Allan Lajeunesse"], "AnotherStory Assessment"],
    ["LUCAS SELTZER: AnotherStory Assessment", ["Lucas Seltzer"], "AnotherStory Assessment"],
    ["Ben and Stephen Jones", ["Stephen Jones"], null],
    ["Nathan Zachary Huff and Benjamin Strout", ["Nathan Zachary Huff"], null],
    ["Meeting with John Tabor", ["John Tabor"], "Meeting"],
    ["Ben and Jeremy about Claudio", ["Jeremy"], "Claudio"],
    ["Rick Elliot Intake Call", ["Rick Elliot"], "Intake Call"],
    ["Ben Strout's Zoom Meeting", [], "Zoom Meeting"],
    ["Executive Meeting - Monday Planning & Prayer", [], null],
    ["Review Ketcham and Harwell bids for Denton", [], null],
  ])("%s", (title, names, topic) => {
    const p = parseTitle(title);
    expect(p.names).toEqual(names);
    expect(p.topic).toBe(topic);
  });

  it("normalises stray spaces and never returns Ben", () => {
    expect(normalizeTitle("  Allan   Lajeunesse :AnotherStory  Assessment ")).toBe("Allan Lajeunesse: AnotherStory Assessment");
    expect(parseTitle("Ben Strout: weekly notes").names).toEqual([]);
  });

  it("normalises names for matching", () => {
    expect(normalizeName("José  O'Neil-Smith")).toBe("jose oneil smith");
    expect(firstLastKey("Lucas C Seltzer")).toBe("lucas seltzer");
    expect(firstLastKey("Nea")).toBeNull();
  });
});

describe("due dates", () => {
  // Wednesday 2026-10-28, 10:00 in Chicago.
  const wed = new Date("2026-10-28T15:00:00Z");
  it.each([
    ["Friday", "2026-10-30"],
    ["by Friday", "2026-10-30"],
    ["this Friday", "2026-10-30"],
    ["next Friday", "2026-11-06"],
    ["Monday", "2026-11-02"],
    ["Wednesday", "2026-10-28"],
    ["tomorrow", "2026-10-29"],
    ["today", "2026-10-28"],
    ["end of week", "2026-10-30"],
    ["EOW", "2026-10-30"],
    ["next week", "2026-11-02"],
    ["end of next week", "2026-11-06"],
    ["end of the month", "2026-10-31"],
    ["in 2 weeks", "2026-11-11"],
    ["in three days", "2026-10-31"],
    ["10/30", "2026-10-30"],
    ["Nov 3", "2026-11-03"],
    ["November 3rd", "2026-11-03"],
    ["the 15th", "2026-11-15"],
    ["2026-11-02", "2026-11-02"],
  ])("%s -> %s", (phrase, want) => {
    expect(resolveDueDate(phrase, wed)).toBe(want);
  });

  it("counts from the local day it was said, not the UTC day", () => {
    // 22:00 Tuesday in Chicago is 03:00 Wednesday UTC: "tomorrow" is Wednesday.
    expect(resolveDueDate("tomorrow", new Date("2026-10-28T03:00:00Z"))).toBe("2026-10-28");
  });

  it("returns null for vague or past phrases, and prefers its own reading over the model's date", () => {
    expect(resolveDueDate("soon", wed)).toBeNull();
    expect(resolveDueDate("2025-01-01", wed)).toBeNull();
    expect(pickDueDate("Friday", "2026-11-13", wed)).toBe("2026-10-30");
    expect(pickDueDate("when he is back", "2026-11-13", wed)).toBe("2026-11-13");
    expect(pickDueDate(null, "Friday", wed)).toBeNull();
    expect(validIsoDate("2026-02-30")).toBeNull();
  });
});

describe("people matching", () => {
  const parties = [
    { id: 1, name: "Ryan Meagher" },
    { id: 2, name: "Lucas C Seltzer" },
    { id: 3, name: "Benjamin Schiavi" },
    { id: 4, name: "Sam Lee" },
    { id: 5, name: "Sam Lee" },
  ];
  it("matches exact and first + last names, flags duplicates as ambiguous, and only suggests close names", () => {
    expect(matchName("RYAN MEAGHER", parties)).toEqual({ kind: "exact", party: parties[0] });
    expect(matchName("Lucas Seltzer", parties)).toEqual({ kind: "exact", party: parties[1] });
    expect(matchName("Sam Lee", parties)).toMatchObject({ kind: "ambiguous" });
    expect(matchName("Bejamin Schiavi", parties, [{ id: 3, name: "Benjamin Schiavi", similarity: 0.72 }])).toMatchObject({ kind: "suggest", party: { id: 3 } });
    expect(matchName("Bejamin Schiavi", parties, [{ id: 3, name: "Benjamin Schiavi", similarity: 0.3 }])).toEqual({ kind: "none" });
    expect(matchName("Nea", [{ id: 9, name: "Nea" }].slice(1))).toEqual({ kind: "none" });
  });

  it("collects title names, name-like speaker labels and identifiers, never Ben", () => {
    const c = localCandidates({ kind: "meeting", source: "zoom", title: "Ryan Meagher: AnotherStory Assessment", speakers: ["Ben Strout", "Ryan Meagher", "Speaker 2"], participantsRaw: [], otherParty: null });
    expect(c).toEqual([
      { name: "Ryan Meagher", source: "title" },
      { name: "Ryan Meagher", source: "speaker", speakerLabel: "Ryan Meagher" },
    ]);
    const call = localCandidates({ kind: "call", source: "iphone_call", title: "Call Recording", speakers: [], participantsRaw: [{ kind: "phone", identifier: "+12055550142", name: null }], otherParty: null });
    expect(call).toEqual([{ phone: "+12055550142", name: null, source: "phone" }]);
  });

  it("picks the calendar event that starts with the Zoom meeting", () => {
    const at = new Date("2026-10-28T19:30:00Z");
    const events = [
      { id: "a", start: { dateTime: "2026-10-28T19:30:00Z" }, location: "https://us02web.zoom.us/j/89603448408", attendees: [{ email: "ryan@bvmhomes.com" }] },
      { id: "b", start: { dateTime: "2026-10-28T19:30:00Z" }, location: "Office", attendees: [{ email: "x@y.com" }] },
      { id: "c", start: { dateTime: "2026-10-28T22:00:00Z" }, location: "zoom.us", attendees: [{ email: "late@y.com" }] },
    ];
    expect(pickCalendarEvent(events, at, "89603448408")?.id).toBe("a");
    expect(pickCalendarEvent([events[1]], at, null)?.id).toBe("b");
    expect(pickCalendarEvent([events[2]], at, null)).toBeNull();
  });

  it("finds the call a 'Call Recording' was made on in the call log", () => {
    const calls = [
      { at: new Date("2026-10-20T14:00:00Z"), durationSec: 600, address: "+12055550142", name: "Kevin McGuire" },
      { at: new Date("2026-10-20T16:00:00Z"), durationSec: 60, address: "+12055550199", name: null },
    ];
    expect(matchCallLog({ createdAt: new Date("2026-10-20T14:01:00Z"), durationSec: 590 }, calls)).toEqual({ name: "Kevin McGuire", phone: "+12055550142" });
    expect(matchCallLog({ createdAt: new Date("2026-10-20T14:10:30Z"), durationSec: 590 }, calls)?.phone).toBe("+12055550142"); // stamped at the end
    expect(matchCallLog({ createdAt: new Date("2026-10-20T15:00:00Z"), durationSec: 100 }, calls)).toBeNull();
  });
});

describe("extraction details", () => {
  it("stores the five types in the facts table's spellings", () => {
    expect(STORED_KIND).toEqual({ commitment: "commitment", task: "task", follow_up: "followup", decision: "decision", amount: "price" });
  });
  it("finds the message a quote came from", () => {
    const chunk = [
      { idx: 4, start_sec: 0, text: "Can you send the plans?" },
      { idx: 5, start_sec: 3600, text: "Yes, I'll send the vetted set by Friday." },
      { idx: 6, start_sec: 7200, text: "Thanks" },
    ];
    expect(segmentIndexFor(chunk, 0, "I'll send the vetted set by Friday")).toBe(5);
    expect(segmentIndexFor(chunk, 7300, "")).toBe(6);
  });
});

describe("connector scope", () => {
  it("keeps phalanx and inbox out of every wildcard, and ticks personal by default for Ben's connector", async () => {
    const known = ["another_story", "credvault", "inbox", "personal", "phalanx", "sepp", "southern_shutter", "strout_arch"];
    const star = await resolveScope({} as never, ["*"], known);
    expect(star.ids).not.toContain("phalanx");
    expect(star.ids).not.toContain("inbox");
    const withPersonal = await resolveScope({} as never, ["*", "personal"], known);
    expect(withPersonal.ids).toContain("personal");
    expect(withPersonal.ids).not.toContain("phalanx");
    expect(withPersonal.ids).not.toContain("inbox");
    expect(RESTRICTED_WORKSPACES).toEqual(expect.arrayContaining(["phalanx", "inbox", "personal"]));
    expect(CONNECTOR_DEFAULT_RESTRICTED).toEqual(["personal"]);
    const params: unknown[] = [];
    expect(scopeSql(withPersonal, params)).toBe("i.workspace_id = any($1::text[])");
    expect(params[0]).not.toContain("phalanx");
  });
});

describe("phalanx guard on filed items", () => {
  it("does not move a filed item on investor vocabulary alone, but does once Claude confirms", () => {
    const base = sig({ current: "credvault", phalanxLines: { strong: 0, weak: 2 } });
    expect(decide(base)).toMatchObject({ workspaceId: "credvault", changed: false });
    expect(needsLlm(decide(base), base, 0.8)).toBe(true);
    expect(decide({ ...base, llm: llm("credvault", 0.9, true) })).toMatchObject({ workspaceId: "inbox", review: { suggested: "phalanx" } });
    expect(decide({ ...base, llm: llm("credvault", 0.9, false) })).toMatchObject({ workspaceId: "credvault", changed: false });
  });
});
