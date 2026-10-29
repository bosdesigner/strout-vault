import { describe, expect, it } from "vitest";
import path from "node:path";
import { displayName, isFuzzyNameMatch, isOwnerName, normalizeName, parseTitleNames, parseTitleNamesDetailed } from "../../server/participants/names.ts";
import { loadFilingRules, matchFilingRule, normalizeTitle, parseFilingRules } from "../../server/workspaces/filing.ts";

const rules = loadFilingRules(path.resolve(__dirname, "../../config"));

describe("parseTitleNames", () => {
  it("reads the assessment titles, including the stray space before the colon and all caps", () => {
    expect(parseTitleNames("Tanner Durfee: AnotherStory Assessment")).toEqual(["Tanner Durfee"]);
    expect(parseTitleNames("Ryan Meagher: AnotherStory Assessment")).toEqual(["Ryan Meagher"]);
    expect(parseTitleNames("Allan Lajeunesse : AnotherStory Assessment")).toEqual(["Allan Lajeunesse"]);
    expect(parseTitleNames("MARA SELBY: AnotherStory Assessment")).toEqual(["Mara Selby"]);
    expect(parseTitleNames("Jaret K: AnotherStory Assessment")).toEqual(["Jaret K"]);
    expect(parseTitleNames("Bejamin Schiavi: AnotherStory Assessment")).toEqual(["Bejamin Schiavi"]);
  });

  it("leaves Ben out and reads the other shapes Ben's calendar produces", () => {
    expect(parseTitleNames("Nolan Zane Hart and Benjamin Strout")).toEqual(["Nolan Zane Hart"]);
    expect(parseTitleNames("Derek Holloway  and Benjamin Strout")).toEqual(["Derek Holloway"]);
    expect(parseTitleNames("Dana Bellweather and Ben Strout alignment ")).toEqual(["Dana Bellweather"]);
    expect(parseTitleNames("Ben and Noa")).toEqual(["Noa"]);
    expect(parseTitleNames("Ben and Lena Bartow ")).toEqual(["Lena Bartow"]);
    expect(parseTitleNames("Ben and Noa about Payne ")).toEqual(["Noa"]);
    expect(parseTitleNames("Ben and Jared about Corwin")).toEqual(["Jared"]);
    expect(parseTitleNames("Meeting with Jon Tavers")).toEqual(["Jon Tavers"]);
    expect(parseTitleNames("Meeting with Kurt, Dale, Sean, and Ivo of the QRS Home Team ")).toEqual(["Kurt", "Dale", "Sean"]);
    expect(parseTitleNames("Intro call with Ben and Mirabel")).toEqual(["Mirabel"]);
    expect(parseTitleNames("Call with Barney Hollis · 2026-10-27")).toEqual(["Barney Hollis"]);
    expect(parseTitleNames("Nadim Marsh")).toEqual(["Nadim Marsh"]);
    // A company in the phone's contacts is not a person.
    expect(parseTitleNames("Call with Brisco Steel · 2024-12-02")).toEqual([]);
    expect(parseTitleNames("Call with Gulf Coast Millwork")).toEqual([]);
  });

  it("finds no one in account-default and topic titles", () => {
    for (const t of ["Ben Strout's Zoom Meeting", "Another Story's Zoom Meeting", "Call Recording", "Leadership Meeting - Monday Planning", "Weekly Q&A Classes - Home Design Live!", "TikTok live ", "Roadmap Zoom call", "team meeting ", "Kitchen walkthrough", "Pell site walk", "", null]) {
      expect(parseTitleNames(t as string | null)).toEqual([]);
    }
  });
});

describe("titles from the production backlog (2026-10-29 dry run)", () => {
  it("names a person firmly only in a deliberate shape; free text only ever matches someone known", () => {
    expect(parseTitleNamesDetailed("Tanner Durfee: AnotherStory Assessment")).toEqual([{ name: "Tanner Durfee", strong: true }]);
    expect(parseTitleNamesDetailed("Amber Ashby, Feasibility Study Discovery Call is Confirmed!")).toEqual([{ name: "Amber Ashby", strong: true }]);
    expect(parseTitleNamesDetailed("Meeting with Jon Tavers")).toEqual([{ name: "Jon Tavers", strong: true }]);
    expect(parseTitleNamesDetailed("Derek Holloway  and Benjamin Strout")).toEqual([{ name: "Derek Holloway", strong: false }]);
    expect(parseTitleNamesDetailed("Andy Thorne Feasibility Study Onboarding Meeting")).toEqual([{ name: "Andy Thorne", strong: false }]);
  });

  it("drops topics, possessives of Ben, run-together names and one-word projects", () => {
    for (const t of [
      "Ben Strout's with the Nashes",
      "Ben Strout's VA Interview",
      "Call with Drift Development",
      "Bellamy Feasibility Study Delivery",
      "Dunmore discussion",
      "Brandt Review",
      "Review Sorrell Feasibility Study",
      "Next Steps",
      "AnotherStory Intake",
      "Call with Drift Development",
      "Greenport Baptist Church review",
      "Ask an architect: 30 min discovery ",
    ]) {
      expect(parseTitleNames(t), t).toEqual([]);
    }
    expect(parseTitleNames("Tanner Durfee Next Steps: pricing")).toEqual(["Tanner Durfee"]);
    // Only "John" survives, as a weak one-word name, which the resolver never links (tests/api/phase1.test.ts).
    expect(parseTitleNamesDetailed("Bram Jory Ben and John ")).toEqual([{ name: "John", strong: false }]);
    // Free text can still yield a weak two-word name; it is only ever matched, never created.
    expect(parseTitleNamesDetailed("Corwin Jory and Ben ")).toEqual([{ name: "Corwin Jory", strong: false }]);
    expect(isOwnerName("Ben Strout's")).toBe(true);
  });
});

describe("names", () => {
  it("normalizes case, accents, punctuation and middle initials", () => {
    expect(normalizeName("Mara J Selby")).toBe("mara selby");
    expect(normalizeName("  José  O'Neil ")).toBe("jose oneil");
    expect(displayName("MARA SELBY")).toBe("Mara Selby");
    expect(displayName("Kevin McGuire")).toBe("Kevin McGuire");
  });

  it("recognises Ben by any of his names", () => {
    for (const n of ["Ben", "Benjamin Strout", "BEN STROUT", "ben"]) expect(isOwnerName(n)).toBe(true);
    expect(isOwnerName("Bejamin Schiavi")).toBe(false);
    expect(isOwnerName("Ben Smith")).toBe(false);
  });

  it("treats a typo as a fuzzy match (a suggestion) but never an exact one or a different person", () => {
    expect(isFuzzyNameMatch("Bejamin Schiavi", "Benjamin Schiavi")).toBe(true);
    expect(isFuzzyNameMatch("Jon Bray", "Jonathan Bray")).toBe(true);
    expect(isFuzzyNameMatch("Tanner Durfee", "Tanner Durfee")).toBe(false);
    expect(isFuzzyNameMatch("Ryan Meagher", "Ryan Mahoney")).toBe(false);
    expect(isFuzzyNameMatch("Tanner Durfee", "Tanner Smith")).toBe(false);
    expect(isFuzzyNameMatch("Nea", "Neal")).toBe(false); // single names never fuzzy-match
  });
});

describe("filing rules", () => {
  it("ships rules that file assessments and feasibility work under another_story", () => {
    const ws = (t: string, source = "zoom") => matchFilingRule(t, source, rules)?.rule.workspaceId ?? null;
    expect(ws("Tanner Durfee: AnotherStory Assessment")).toBe("another_story");
    expect(ws("Allan Lajeunesse : AnotherStory Assessment")).toBe("another_story");
    expect(ws("Another Story's Zoom Meeting")).toBe("another_story");
    expect(ws("Kitchen assessment with the Parkers")).toBe("another_story");
    expect(ws("Feasibility Study Delivery - Mayfield")).toBe("another_story");
    expect(ws("Discovery call: 12 Oak St")).toBe("another_story");
    expect(ws("Contractor onboarding")).toBe("another_story");
    expect(ws("Ben Strout's Zoom Meeting")).toBeNull();
    expect(ws("Ben and Noa")).toBeNull();
    expect(ws("")).toBeNull();
  });

  it("normalizes stray spaces before matching", () => {
    expect(normalizeTitle("Allan Lajeunesse : AnotherStory   Assessment ")).toBe("Allan Lajeunesse: AnotherStory Assessment");
  });

  it("honours sources, order, and rejects bad config loudly", () => {
    const custom = parseFilingRules({
      rules: [
        { workspace: "strout_arch", titles: ["design meeting"], sources: ["meet"] },
        { workspace: "sepp", titles: ["design"] },
      ],
    });
    expect(matchFilingRule("Design meeting", "meet", custom)?.rule.workspaceId).toBe("strout_arch");
    expect(matchFilingRule("Design meeting", "zoom", custom)?.rule).toMatchObject({ workspaceId: "sepp", index: 2 });
    expect(() => parseFilingRules({ rules: [{ workspace: "Bad Id", titles: ["x"] }] })).toThrow(/workspace/);
    expect(() => parseFilingRules({ rules: [{ workspace: "sepp", titles: ["("] }] })).toThrow(/bad pattern/);
    expect(() => parseFilingRules({ rules: [{ workspace: "sepp" }] })).toThrow(/titles/);
    expect(parseFilingRules(null)).toEqual([]);
  });
});
