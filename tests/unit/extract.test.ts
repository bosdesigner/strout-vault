import { describe, expect, it } from "vitest";
import { contextText, dedupeProposals, normalizeText, toProposals, type ExtractOutput, type RecordingContext } from "../../server/worker/extract.ts";

const rc: RecordingContext = {
  interactionId: 7,
  title: "Kitchen walkthrough",
  occurredAt: "2026-10-20T15:00:00.000Z",
  workspaceId: "strout_arch",
  roster: [
    { id: 1, name: "Ben Strout", kind: "person", detail: "on this recording as Ben" },
    { id: 2, name: "Dana Client", kind: "person", detail: "client" },
  ],
  projects: [{ id: 10, name: "Maple St remodel", address: "12 Maple St", status: "design" }],
  labels: [
    { label: "Ben", lines: 40, partyId: 1 },
    { label: "Speaker 2", lines: 30, partyId: null },
  ],
  participantIds: new Set([1]),
  linkedProjectIds: new Set(),
};

const fact = (over: Partial<ExtractOutput["facts"][number]> = {}): ExtractOutput["facts"][number] => ({
  kind: "commitment",
  text: "Ben will send Dana the revised plan by Friday",
  owner_party_id: 1,
  about_party_id: 2,
  project_id: 10,
  amount: null,
  due_date: "2026-10-24",
  quote_start_sec: 120,
  quote: "I'll get you the revised plan Friday",
  confidence: 0.9,
  ...over,
});

describe("toProposals", () => {
  it("keeps a sound fact and drops ids that were never offered, bad dates and out-of-chunk moments", () => {
    const out: ExtractOutput = {
      facts: [
        fact(),
        fact({ text: "unknown people", owner_party_id: 99, about_party_id: 98, project_id: 97, due_date: "Friday" }),
        fact({ text: "outside", quote_start_sec: 5000 }),
        fact({ text: "unsure", confidence: 0.4 }),
        fact({ text: "   " }),
      ],
      speakers: [],
      projects: [],
    };
    const p = toProposals(out, rc, 0, 1500, 0.6);
    expect(p.map((x) => x.proposal.text)).toEqual(["Ben will send Dana the revised plan by Friday", "unknown people"]);
    expect(p[0]).toMatchObject({ itemType: "new_fact", key: "fact:commitment:ben will send dana the revised plan by friday" });
    expect(p[0].proposal).toEqual({
      interaction_id: 7,
      workspace_id: "strout_arch",
      kind: "commitment",
      text: "Ben will send Dana the revised plan by Friday",
      owner_party_id: 1,
      about_party_id: 2,
      project_id: 10,
      due_date: "2026-10-24",
      quote_start_sec: 120,
      confidence: 0.9,
    });
    expect(p[0].reason).toBe("“I'll get you the revised plan Friday” at 00:02:00");
    expect(p[1].proposal).not.toHaveProperty("owner_party_id");
    expect(p[1].proposal).not.toHaveProperty("project_id");
    expect(p[1].proposal).not.toHaveProperty("due_date");
  });

  it("only matches unmatched labels to known people who are not on the recording yet", () => {
    const out: ExtractOutput = {
      facts: [],
      speakers: [
        { speaker_label: "Speaker 2", party_id: 2, confidence: 0.8, evidence: "Ben calls her Dana" },
        { speaker_label: "Ben", party_id: 2, confidence: 0.9, evidence: "already matched label" },
        { speaker_label: "Speaker 2", party_id: 1, confidence: 0.9, evidence: "already a participant" },
        { speaker_label: "Speaker 9", party_id: 2, confidence: 0.9, evidence: "not in this recording" },
        { speaker_label: "Speaker 2", party_id: 55, confidence: 0.9, evidence: "unknown party" },
      ],
      projects: [
        { project_id: 10, confidence: 0.7, evidence: "the whole call" },
        { project_id: 11, confidence: 0.9, evidence: "not offered" },
      ],
    };
    const p = toProposals(out, rc, 0, 1500, 0.6);
    expect(p.map((x) => x.key)).toEqual(["speaker:Speaker 2", "project:10"]);
    expect(p[0].proposal).toEqual({ party_id: 2, interaction_id: 7, speaker_label: "Speaker 2", confidence: 0.8 });
    expect(p[0].reason).toBe("Speaker 2 is Dana Client: Ben calls her Dana");
  });
});

describe("dedupeProposals", () => {
  it("keeps one fact per text, the most confident match per label, and one label per person", () => {
    const sp = (label: string, party: number, confidence: number) => ({
      itemType: "link_party_interaction" as const,
      proposal: { party_id: party, interaction_id: 7, speaker_label: label, confidence },
      reason: "",
      key: `speaker:${label}`,
    });
    const f = { itemType: "new_fact" as const, proposal: { text: "a" }, reason: "", key: "fact:commitment:a" };
    const out = dedupeProposals([f, { ...f, reason: "second" }, sp("Speaker 2", 2, 0.7), sp("Speaker 2", 2, 0.9), sp("Speaker 3", 2, 0.8)]);
    expect(out).toHaveLength(2);
    expect(out[0].reason).toBe("");
    expect(out[1].proposal).toMatchObject({ speaker_label: "Speaker 2", confidence: 0.9 });
  });
});

describe("contextText", () => {
  it("lists the roster, projects and which labels are still unmatched", () => {
    const t = contextText(rc);
    expect(t).toContain("Recording #7: Kitchen walkthrough");
    expect(t).toContain("Date: 2026-10-20");
    expect(t).toContain("- 2 · Dana Client · client");
    expect(t).toContain("- 10 · Maple St remodel · 12 Maple St · design");
    expect(t).toContain("- Ben (40 lines): already matched to Ben Strout");
    expect(t).toContain("- Speaker 2 (30 lines): unmatched");
  });

  it("normalizes text for duplicate checks", () => {
    expect(normalizeText("  Ben will send $4,500 quote!! ")).toBe("ben will send $4 500 quote");
  });
});
