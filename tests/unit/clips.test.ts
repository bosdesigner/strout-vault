import { describe, expect, it } from "vitest";
import { assEscape, buildAss, captionLines, escapeFilterPath, synthesizeWords, verticalCrop } from "../../server/worker/captions.ts";
import { chunkSegments, chunkText, estimateScoutCostUsd, filterCandidates, usageCostUsd } from "../../server/worker/scout.ts";
import { clipKey, clipSlug } from "../../server/worker/cut.ts";

describe("captions", () => {
  it("groups word timings into short lines, splitting on silence, length and word count", () => {
    const words = ["so", "the", "first", "time", "we", "added", "a", "second", "story", "it", "went", "badly"].map((w, i) => ({ start: 100 + i * 0.4, end: 100 + i * 0.4 + 0.35, word: w }));
    // A pause before "it".
    for (let i = 9; i < words.length; i++) {
      words[i].start += 1.5;
      words[i].end += 1.5;
    }
    const lines = captionLines([{ start: 100, end: 110, text: words.map((w) => w.word).join(" "), words }], 100, 110);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].start).toBeCloseTo(0, 5); // relative to the clip start
    for (const l of lines) {
      expect(l.text.length).toBeLessThanOrEqual(24);
      expect(l.text.split(" ").length).toBeLessThanOrEqual(5);
      expect(l.end).toBeGreaterThan(l.start);
    }
    // The pause forced a new line at "it".
    expect(lines.some((l) => l.text.startsWith("it"))).toBe(true);
    // Lines never overlap the next one.
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].end).toBeLessThanOrEqual(lines[i].start + 1e-9);
  });

  it("falls back to synthesized word timings when a transcript has none, and clips to the window", () => {
    const lines = captionLines([{ start: 10, end: 14, text: "Thanks for making the time today everyone", words: null }], 11, 13);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].start).toBeGreaterThanOrEqual(0);
    expect(lines[lines.length - 1].end).toBeLessThanOrEqual(2 + 1e-9);
    const synth = synthesizeWords("a bb ccc", 0, 6);
    expect(synth.map((w) => w.word)).toEqual(["a", "bb", "ccc"]);
    expect(synth[2].end).toBe(6);
    expect(synth[0].end - synth[0].start).toBeLessThan(synth[2].end - synth[2].start); // weighted by length
  });

  it("writes a valid ASS file and escapes braces and backslashes", () => {
    const ass = buildAss([{ start: 0, end: 1.5, text: "hello {there}\\" }], 1080, 1920);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Style: Cap,DejaVu Sans,88,");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Cap,,0,0,0,,hello (there)\\\\");
    expect(assEscape("a\nb")).toBe("a\\Nb");
    expect(escapeFilterPath("/tmp/it's:here.ass")).toBe("'/tmp/it'\\''s\\:here.ass'");
  });

  it("computes an even 9:16 crop inside landscape and portrait frames", () => {
    expect(verticalCrop(1920, 1080)).toEqual([608, 1080, 656, 0]);
    expect(verticalCrop(1920, 1080, 0)).toEqual([608, 1080, 0, 0]);
    expect(verticalCrop(1920, 1080, 1)).toEqual([608, 1080, 1312, 0]);
    expect(verticalCrop(1080, 1920)).toEqual([1080, 1920, 0, 0]);
    expect(verticalCrop(720, 1600)).toEqual([720, 1280, 0, 160]);
  });
});

describe("scout helpers", () => {
  const seg = (start: number, end: number, text: string, speaker: string | null = null) => ({ start_sec: start, end_sec: end, text, speaker });

  it("splits a transcript into 25-minute chunks and renders stamped lines", () => {
    const segments = Array.from({ length: 60 }, (_, i) => seg(i * 60, i * 60 + 50, `line ${i}`, i % 2 ? "Ben Strout" : null));
    const chunks = chunkSegments(segments);
    expect(chunks.length).toBe(3);
    expect(chunks[0][0].start_sec).toBe(0);
    expect(chunks[1][0].start_sec).toBeGreaterThanOrEqual(25 * 60);
    expect(chunkText(chunks[0]).split("\n")[1]).toBe("[00:01:00] Ben Strout: line 1");
  });

  it("drops candidates outside the chunk, too short, too long or mis-scored", () => {
    const out = {
      candidates: [
        { start_sec: 100, end_sec: 140, score: 8, hook: "keep", why: "fine", platforms: ["tiktok" as const] },
        { start_sec: 5000, end_sec: 5030, score: 9, hook: "invented", why: "outside", platforms: [] },
        { start_sec: 100, end_sec: 103, score: 7, hook: "too short", why: "", platforms: [] },
        { start_sec: 100, end_sec: 300, score: 7, hook: "too long", why: "", platforms: [] },
        { start_sec: 200, end_sec: 240, score: 11, hook: "score", why: "", platforms: [] },
        { start_sec: 1480, end_sec: 1520, score: 6, hook: "just past the end is fine", why: "", platforms: ["linkedin" as const] },
      ],
    };
    const kept = filterCandidates(out, 0, 1500);
    expect(kept.map((c) => c.hook)).toEqual(["keep", "just past the end is fine"]);
    expect(kept[0].platforms).toBe("tiktok");
    expect(filterCandidates(null, 0, 10)).toEqual([]);
  });

  it("prices estimates and usage by model", () => {
    // 9,000 words in one chunk on Opus 5.5: ~12,750 tokens at $4/M plus 2% output at $20/M.
    expect(estimateScoutCostUsd(9000, 1, "claude-opus-5-5")).toBeCloseTo((12750 * 4 + 12750 * 0.02 * 20) / 1e6, 6);
    expect(usageCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, "claude-opus-5-5")).toBeCloseTo(4, 6);
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, "claude-opus-5-5")).toBeCloseTo(20.2, 6);
    expect(usageCostUsd({ input_tokens: 1_000_000 }, "claude-haiku-5-5")).toBeCloseTo(0.1, 6);
    expect(usageCostUsd(null, "unknown-model")).toBe(0);
  });

  it("names clip objects by date, id and hook", () => {
    expect(clipSlug("So the first time we added a second story, it didn't go well!")).toBe("so-the-first-time-we-added-a-second-story-it-did");
    expect(clipSlug("")).toBe("clip");
    expect(clipKey({ id: 338, hook: "So the first time", title: null, occurred_at: new Date("2026-10-08T21:14:52Z") })).toBe("clips/2026/10/338_so-the-first-time.mp4");
  });
});
