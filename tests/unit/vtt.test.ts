import { describe, expect, it } from "vitest";
import { cuesToPlainText, parseVtt } from "../../server/worker/vtt.ts";
import { SAMPLE_VTT } from "../mocks/zoomGroq.ts";

describe("parseVtt", () => {
  it("parses cues, pulls out speaker prefixes and strips tags", () => {
    const cues = parseVtt(SAMPLE_VTT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, speaker: "Dana Whitfield", text: "Thanks for making the time today." });
    expect(cues[1].speaker).toBe("Ben Strout");
    expect(cues[1].text).toBe("Of course. Let's start with the pelican roof tiles.");
    // A zero-length cue gets a minimal duration rather than end <= start.
    expect(cues[2].end).toBeCloseTo(cues[2].start + 0.5, 5);
  });

  it("handles CRLF, a BOM, hour-less timestamps, NOTE blocks and cues without a speaker", () => {
    const raw = "﻿WEBVTT\r\n\r\nNOTE made by a test\r\n\r\n00:05.000 --> 00:07.250\r\nJust a line.\r\n\r\n00:07.300 --> 00:08.000\r\n\r\n";
    const cues = parseVtt(raw);
    expect(cues).toEqual([{ start: 5, end: 7.25, speaker: null, text: "Just a line." }]);
  });

  it("does not mistake a colon inside a long sentence for a speaker label", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThe schedule for the pour, the inspection, the framing, the roof and the final walkthrough: all of it slips a week.\n");
    expect(cues[0].speaker).toBeNull();
  });

  it("renders plain text with timestamps and speakers", () => {
    const text = cuesToPlainText(parseVtt(SAMPLE_VTT));
    expect(text.split("\n")[0]).toBe("[00:00:01] Dana Whitfield: Thanks for making the time today.");
    expect(text).toContain("[00:00:03] Ben Strout: Of course.");
  });
});
