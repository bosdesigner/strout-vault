import { describe, expect, it } from "vitest";
import { classifyRecording, isAccountDefaultTitle, type RecordingSignals } from "../../server/workspaces/classify.ts";

const base = (over: Partial<RecordingSignals>): RecordingSignals => ({ interactionId: 1, title: null, transcriptHits: {}, peopleInTitle: [], segmentCount: 300, ...over });

describe("workspace classifier", () => {
  it("knows Zoom's account-default titles carry no signal", () => {
    for (const t of ["Ben Strout's Zoom Meeting", "Another Story's Zoom Meeting", "Zoom Meeting", "Ben Strout's Personal Meeting Room", "a91f3c0d7e2b48f6", "IMG_4821", "2024-06-11 14.02.11", "", null]) {
      expect(isAccountDefaultTitle(t), String(t)).toBe(true);
    }
    expect(isAccountDefaultTitle("Harper Design Meeting")).toBe(false);
    expect(isAccountDefaultTitle("Tanner Durfee: AnotherStory Assessment")).toBe(false);
  });

  it("files by title pattern with high confidence", () => {
    expect(classifyRecording(base({ title: "Tanner Durfee: AnotherStory Assessment" }))).toMatchObject({ workspaceId: "another_story", confidence: 0.9 });
    expect(classifyRecording(base({ title: "Phalanx Nano Zoom Meeting" }))).toMatchObject({ workspaceId: "phalanx" });
    expect(classifyRecording(base({ title: "PN Zoom Meeting" }))).toMatchObject({ workspaceId: "phalanx" });
    expect(classifyRecording(base({ title: "Harper Design Meeting" }))).toMatchObject({ workspaceId: "strout_arch" });
    expect(classifyRecording(base({ title: "Jacob Jetton-Gonzales, Feasibility Study Discovery Call is Confirmed!" }))).toMatchObject({ workspaceId: "strout_arch" });
    expect(classifyRecording(base({ title: "Contractor Call - Dax - 5 Fort Contractors" }))).toMatchObject({ workspaceId: "another_story" });
  });

  it("uses a known person's name in the title, strongly for full names and weakly for first names", () => {
    const strong = classifyRecording(base({ title: "Ben and Jeremy Wenger", peopleInTitle: [{ name: "Jeremy Wenger", workspaceId: "another_story", strong: true }] }));
    expect(strong).toMatchObject({ workspaceId: "another_story", confidence: 0.85 });
    const weak = classifyRecording(base({ title: "Ben and Logan", peopleInTitle: [{ name: "Logan", workspaceId: "another_story", strong: false }] }));
    expect(weak).toMatchObject({ workspaceId: "another_story", confidence: 0.6 });
    // A name in an account-default title is not consulted (there is none), and an empty title yields nothing.
    expect(classifyRecording(base({ title: "Ben Strout's Zoom Meeting" }))).toBeNull();
  });

  it("falls back to a clear transcript keyword majority for generic titles, and stays quiet otherwise", () => {
    expect(classifyRecording(base({ title: "Ben Strout's Zoom Meeting", transcriptHits: { phalanx: 12, another_story: 1 } }))).toMatchObject({ workspaceId: "phalanx", confidence: 0.75 });
    expect(classifyRecording(base({ title: "Zoom Meeting", transcriptHits: { strout_arch: 5 } }))).toMatchObject({ workspaceId: "strout_arch", confidence: 0.7 });
    expect(classifyRecording(base({ title: "Zoom Meeting", transcriptHits: { strout_arch: 3 } }))).toMatchObject({ workspaceId: "strout_arch", confidence: 0.6 });
    // Too few hits, or no clear majority: undecided.
    expect(classifyRecording(base({ title: "Zoom Meeting", transcriptHits: { strout_arch: 2 } }))).toBeNull();
    expect(classifyRecording(base({ title: "Zoom Meeting", transcriptHits: { strout_arch: 9, another_story: 4 } }))).toBeNull();
    expect(classifyRecording(base({ title: "Zoom Meeting" }))).toBeNull();
  });

  it("combines agreeing signals, discounts a competing one, and refuses two strong disagreeing ones", () => {
    const agree = classifyRecording(base({ title: "Patrick Hill: AnotherStory Assessment", transcriptHits: { another_story: 20 } }));
    expect(agree).toMatchObject({ workspaceId: "another_story", confidence: 0.95 });
    expect(agree!.evidence).toHaveLength(2);
    const competing = classifyRecording(base({ title: "Matt Wilkes: AnotherStory Intro Consultation", transcriptHits: { strout_arch: 15 } }));
    expect(competing).toMatchObject({ workspaceId: "another_story", confidence: 0.8 });
    expect(competing!.alsoConsidered[0]).toMatch(/^strout_arch/);
    const conflict = classifyRecording(base({ title: "Phalanx Nano design meeting" })); // phalanx title + strout_arch title pattern
    expect(conflict).toBeNull();
  });
});
