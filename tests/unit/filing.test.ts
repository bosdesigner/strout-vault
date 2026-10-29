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
    expect(parseTitleNames("LUCAS SELTZER: AnotherStory Assessment")).toEqual(["Lucas Seltzer"]);
    expect(parseTitleNames("Jarett B: AnotherStory Assessment")).toEqual(["Jarett B"]);
    expect(parseTitleNames("Bejamin Schiavi: AnotherStory Assessment")).toEqual(["Bejamin Schiavi"]);
  });

  it("leaves Ben out and reads the other shapes Ben's calendar produces", () => {
    expect(parseTitleNames("Nathan Zachary Huff and Benjamin Strout")).toEqual(["Nathan Zachary Huff"]);
    expect(parseTitleNames("Daniel Hardwick  and Benjamin Strout")).toEqual(["Daniel Hardwick"]);
    expect(parseTitleNames("David Balderston and Ben Strout alignment ")).toEqual(["David Balderston"]);
    expect(parseTitleNames("Ben and Nea")).toEqual(["Nea"]);
    expect(parseTitleNames("Ben and Laura Bertram ")).toEqual(["Laura Bertram"]);
    expect(parseTitleNames("Ben and Nea about Payne ")).toEqual(["Nea"]);
    expect(parseTitleNames("Ben and Jeremy about Claudio")).toEqual(["Jeremy"]);
    expect(parseTitleNames("Meeting with John Tabor")).toEqual(["John Tabor"]);
    expect(parseTitleNames("Meeting with Kenneth, Daryl, Shawn, and Ian of the CQC Home Team ")).toEqual(["Kenneth", "Daryl", "Shawn"]);
    expect(parseTitleNames("Intro call with Ben and Marianne")).toEqual(["Marianne"]);
    expect(parseTitleNames("Call with Barry Harwell · 2026-10-27")).toEqual(["Barry Harwell"]);
    expect(parseTitleNames("Naaim Masri")).toEqual(["Naaim Masri"]);
    // A company in the phone's contacts is not a person.
    expect(parseTitleNames("Call with Besco Steel · 2024-12-02")).toEqual([]);
    expect(parseTitleNames("Call with Gulf Coast Millwork")).toEqual([]);
  });

  it("finds no one in account-default and topic titles", () => {
    for (const t of ["Ben Strout's Zoom Meeting", "Another Story's Zoom Meeting", "Call Recording", "Executive Meeting - Monday Planning & Prayer", "Weekly Q&A Classes - Drawing Before and After Home Design in Real Time!", "TikTok live ", "Road map Zoom call", "team meeting ", "Kitchen walkthrough", "Pinson site walk", "", null]) {
      expect(parseTitleNames(t as string | null)).toEqual([]);
    }
  });
});

describe("titles from the production backlog (2026-10-29 dry run)", () => {
  it("names a person firmly only in a deliberate shape; free text only ever matches someone known", () => {
    expect(parseTitleNamesDetailed("Tanner Durfee: AnotherStory Assessment")).toEqual([{ name: "Tanner Durfee", strong: true }]);
    expect(parseTitleNamesDetailed("Amber Autumn, Feasibility Study Discovery Call is Confirmed!")).toEqual([{ name: "Amber Autumn", strong: true }]);
    expect(parseTitleNamesDetailed("Meeting with John Tabor")).toEqual([{ name: "John Tabor", strong: true }]);
    expect(parseTitleNamesDetailed("Daniel Hardwick  and Benjamin Strout")).toEqual([{ name: "Daniel Hardwick", strong: false }]);
    expect(parseTitleNamesDetailed("Andrew Thomson Feasibility Study Onboarding Meeting")).toEqual([{ name: "Andrew Thomson", strong: false }]);
  });

  it("drops topics, possessives of Ben, run-together names and one-word projects", () => {
    for (const t of [
      "Ben Strout's with the Nolen's",
      "Ben Strout's VA Interview",
      "Call with Dust Development",
      "Balyeat Feasibility Study Delivery",
      "Danley discussion",
      "Bratcher Review",
      "Review Schilleci Feasibility Study",
      "Next Steps",
      "AnotherStory Intake",
      "Call with Dust Development",
      "Greensport Baptist Church review",
      "Ask an architect: 30 min discovery ",
    ]) {
      expect(parseTitleNames(t), t).toEqual([]);
    }
    expect(parseTitleNames("Tanner Durfee Next Steps: pricing")).toEqual(["Tanner Durfee"]);
    // Only "John" survives, as a weak one-word name, which the resolver never links (tests/api/phase1.test.ts).
    expect(parseTitleNamesDetailed("Brad Jeremy Ben and John ")).toEqual([{ name: "John", strong: false }]);
    // Free text can still yield a weak two-word name; it is only ever matched, never created.
    expect(parseTitleNamesDetailed("Claudio Jeremy and Ben ")).toEqual([{ name: "Claudio Jeremy", strong: false }]);
    expect(isOwnerName("Ben Strout's")).toBe(true);
  });
});

describe("names", () => {
  it("normalizes case, accents, punctuation and middle initials", () => {
    expect(normalizeName("Lucas C Seltzer")).toBe("lucas seltzer");
    expect(normalizeName("  José  O'Neil ")).toBe("jose oneil");
    expect(displayName("LUCAS SELTZER")).toBe("Lucas Seltzer");
    expect(displayName("Kevin McGuire")).toBe("Kevin McGuire");
  });

  it("recognises Ben by any of his names", () => {
    for (const n of ["Ben", "Benjamin Strout", "BEN STROUT", "ben"]) expect(isOwnerName(n)).toBe(true);
    expect(isOwnerName("Bejamin Schiavi")).toBe(false);
    expect(isOwnerName("Ben Smith")).toBe(false);
  });

  it("treats a typo as a fuzzy match (a suggestion) but never an exact one or a different person", () => {
    expect(isFuzzyNameMatch("Bejamin Schiavi", "Benjamin Schiavi")).toBe(true);
    expect(isFuzzyNameMatch("Jon Brou", "Jonathan Brou")).toBe(true);
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
    expect(ws("Ben and Nea")).toBeNull();
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
