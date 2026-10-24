import { describe, expect, it } from "vitest";
import { buildChunks, renderChunkText, type ChunkSourceSegment } from "../../server/embeddings/chunker.ts";
import { estimateTokens } from "../../server/embeddings/tokens.ts";

/** A transcript of `n` segments, `gap` seconds apart, each about `words` words long. */
function transcript(n: number, { gap = 8, words = 14, speakers = ["Ben", "Kevin"] } = {}): ChunkSourceSegment[] {
  const out: ChunkSourceSegment[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * gap + 0.4;
    out.push({ idx: i, startSec: start, endSec: start + gap * 0.8, speaker: speakers[i % speakers.length], text: Array.from({ length: words }, (_, k) => `word${i}x${k}`).join(" ") });
  }
  return out;
}

describe("chunker", () => {
  it("never splits a segment and keeps chunks contiguous and in order", () => {
    const segs = transcript(120);
    const chunks = buildChunks(segs);
    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((c, i) => {
      expect(c.seq).toBe(i);
      expect(c.lastIdx).toBeGreaterThanOrEqual(c.firstIdx);
      // Every source segment inside the range appears whole in the text.
      for (const s of segs.slice(c.firstIdx, c.lastIdx + 1)) expect(c.text).toContain(s.text);
      // No segment outside the range leaks in.
      if (c.lastIdx + 1 < segs.length) expect(c.text).not.toContain(segs[c.lastIdx + 1].text);
      if (c.firstIdx > 0) expect(c.text).not.toContain(segs[c.firstIdx - 1].text);
    });
    // Chunks advance monotonically and together cover every segment.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].firstIdx).toBeGreaterThan(chunks[i - 1].firstIdx);
    expect(chunks[0].firstIdx).toBe(0);
    expect(chunks[chunks.length - 1].lastIdx).toBe(segs.length - 1);
  });

  it("overlaps consecutive chunks by about 15% of the tokens, on whole segments", () => {
    const segs = transcript(200, { gap: 5, words: 12 });
    const chunks = buildChunks(segs, { overlap: 0.15 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      expect(cur.firstIdx).toBeLessThanOrEqual(prev.lastIdx + 1); // overlap or adjacent, never a gap
      const shared = segs.slice(cur.firstIdx, prev.lastIdx + 1);
      const sharedTokens = shared.reduce((n, s) => n + estimateTokens(s.text), 0);
      expect(sharedTokens).toBeLessThanOrEqual(Math.floor(prev.tokens * 0.15));
      if (shared.length) expect(sharedTokens + estimateTokens(segs[cur.firstIdx - 1].text)).toBeGreaterThan(Math.floor(prev.tokens * 0.15));
    }
  });

  it("sizes chunks to about 400 tokens or 120 seconds, whichever fills first", () => {
    const dense = buildChunks(transcript(300, { gap: 3, words: 20 }));
    for (const c of dense.slice(0, -1)) {
      expect(c.tokens).toBeGreaterThanOrEqual(400);
      expect(c.tokens).toBeLessThan(400 + 40); // one segment past the target at most
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(121);
    }
    const sparse = buildChunks(transcript(60, { gap: 30, words: 10 }));
    for (const c of sparse.slice(0, -1)) {
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(121);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(60);
      expect(c.tokens).toBeLessThan(400);
    }
  });

  it("takes start_sec and end_sec from the first and last source segments", () => {
    const segs = transcript(50, { gap: 7 });
    for (const c of buildChunks(segs)) {
      expect(c.startSec).toBe(Math.floor(segs[c.firstIdx].startSec));
      expect(c.endSec).toBe(Math.ceil(segs[c.lastIdx].endSec));
    }
  });

  it("prefixes speaker turns so who said it is in the text", () => {
    const text = renderChunkText([
      { idx: 0, startSec: 0, endSec: 2, speaker: "Ben", text: "Hello there." },
      { idx: 1, startSec: 2, endSec: 4, speaker: "Ben", text: "Can you hear me?" },
      { idx: 2, startSec: 4, endSec: 6, speaker: "Kevin", text: "Loud and clear." },
      { idx: 3, startSec: 6, endSec: 8, speaker: null, text: "(inaudible)" },
    ]);
    expect(text).toBe("[Ben] Hello there. Can you hear me?\n[Kevin] Loud and clear.\n[Speaker] (inaudible)");
  });

  it("handles edge cases: nothing, one huge segment, out-of-order and empty segments", () => {
    expect(buildChunks([])).toEqual([]);
    const huge = buildChunks([{ idx: 0, startSec: 0, endSec: 900, speaker: "Ben", text: "x ".repeat(3000) }]);
    expect(huge).toHaveLength(1);
    expect(huge[0]).toMatchObject({ seq: 0, startSec: 0, endSec: 900, firstIdx: 0, lastIdx: 0 });
    const shuffled = buildChunks([
      { idx: 1, startSec: 10, endSec: 12, speaker: "A", text: "second" },
      { idx: 2, startSec: 20, endSec: 22, speaker: "A", text: "   " },
      { idx: 0, startSec: 0, endSec: 2, speaker: "A", text: "first" },
    ]);
    expect(shuffled).toHaveLength(1);
    expect(shuffled[0].text).toBe("[A] first second");
  });

  it("is deterministic: the same segments always give the same chunks", () => {
    const segs = transcript(90);
    expect(buildChunks(segs)).toEqual(buildChunks(segs));
  });
});
