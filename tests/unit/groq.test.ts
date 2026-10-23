import { describe, expect, it } from "vitest";
import { attachWords, estimateCostUsd, parseResponse } from "../../server/worker/groq.ts";

describe("parseResponse", () => {
  it("shifts segments and words by the chunk offset and attaches top-level words to segments", () => {
    const { segments, language, duration } = parseResponse(
      {
        language: "en",
        duration: 4,
        segments: [
          { start: 0, end: 2, text: " First part. " },
          { start: 2, end: 4, text: "Second part." },
        ],
        words: [
          { word: "First", start: 0, end: 0.5 },
          { word: "part.", start: 0.5, end: 2 },
          { word: "Second", start: 2, end: 2.5 },
          { word: "part.", start: 2.5, end: 4 },
        ],
      },
      900,
    );
    expect(language).toBe("en");
    expect(duration).toBe(4);
    expect(segments.map((s) => [s.start, s.end, s.text])).toEqual([
      [900, 902, "First part."],
      [902, 904, "Second part."],
    ]);
    expect(segments[0].words.map((w) => w.word)).toEqual(["First", "part."]);
    expect(segments[1].words[0].start).toBe(902);
  });

  it("falls back to the whole text when the API returns no segments", () => {
    const { segments } = parseResponse({ text: "  all of it  ", duration: 10 }, 0);
    expect(segments).toEqual([{ start: 0, end: 10, text: "all of it", words: [] }]);
  });

  it("attachWords leaves segments empty when there are no words", () => {
    const segs = [{ start: 0, end: 1, text: "x", words: [] }];
    attachWords(segs, []);
    expect(segs[0].words).toEqual([]);
  });

  it("estimates cost from list prices", () => {
    expect(estimateCostUsd(3600)).toBeCloseTo(0.04, 6);
    expect(estimateCostUsd(1800, "whisper-large-v3")).toBeCloseTo(0.0555, 6);
    expect(estimateCostUsd(-5)).toBe(0);
  });
});
