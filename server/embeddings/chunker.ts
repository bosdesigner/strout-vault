// Chunks a transcript's segments for embedding. Each chunk is roughly 60-120 seconds of
// conversation or about 400 tokens, whichever fills first, with ~15% overlap carried into
// the next chunk. A segment is never split; speaker labels are written into the text
// ("[Ben] ... [Kevin] ...") so who said it survives into the embedding.
import { estimateTokens } from "./tokens.ts";

export interface ChunkSourceSegment {
  idx: number;
  startSec: number;
  endSec: number;
  speaker: string | null;
  text: string;
}

export interface BuiltChunk {
  seq: number;
  startSec: number;
  endSec: number;
  text: string;
  /** Inclusive idx range of the source segments. */
  firstIdx: number;
  lastIdx: number;
  tokens: number;
}

export interface ChunkOptions {
  /** Stop adding segments once the chunk reaches this many estimated tokens. Default 400. */
  targetTokens?: number;
  /** Stop adding segments once the chunk spans this many seconds. Default 120. */
  maxSeconds?: number;
  /** Fraction of a chunk's tokens repeated at the start of the next chunk. Default 0.15. */
  overlap?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = { targetTokens: 400, maxSeconds: 120, overlap: 0.15 };

export function buildChunks(segments: ChunkSourceSegment[], options: ChunkOptions = {}): BuiltChunk[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const segs = [...segments].filter((s) => s.text && s.text.trim()).sort((a, b) => a.idx - b.idx);
  const tokens = segs.map((s) => estimateTokens(s.text));
  const chunks: BuiltChunk[] = [];
  let i = 0;
  while (i < segs.length) {
    // Grow the chunk one whole segment at a time until a limit is reached.
    let j = i;
    let sum = tokens[i];
    while (j + 1 < segs.length) {
      const next = tokens[j + 1];
      const duration = segs[j + 1].endSec - segs[i].startSec;
      if (sum >= o.targetTokens || duration > o.maxSeconds) break;
      j++;
      sum += next;
    }
    chunks.push({
      seq: chunks.length,
      startSec: Math.floor(segs[i].startSec),
      endSec: Math.ceil(segs[j].endSec),
      text: renderChunkText(segs.slice(i, j + 1)),
      firstIdx: segs[i].idx,
      lastIdx: segs[j].idx,
      tokens: sum,
    });
    if (j + 1 >= segs.length) break;
    // Overlap: the next chunk starts at the earliest trailing segment whose tail adds up to
    // ~15% of this chunk's tokens, and always after this chunk's first segment.
    const budget = Math.floor(sum * o.overlap);
    let k = j + 1;
    let tail = 0;
    while (k - 1 > i && tail + tokens[k - 1] <= budget) {
      k--;
      tail += tokens[k];
    }
    i = Math.max(k, i + 1);
  }
  return chunks;
}

/** "[Speaker] text text\n[Other] text": one line per speaker turn. */
export function renderChunkText(segs: ChunkSourceSegment[]): string {
  const lines: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) lines.push(`[${current ?? "Speaker"}] ${buf.join(" ")}`);
    buf = [];
  };
  for (const s of segs) {
    const label = s.speaker?.trim() || null;
    if (lines.length === 0 && buf.length === 0) current = label;
    if (label !== current) {
      flush();
      current = label;
    }
    buf.push(s.text.trim());
  }
  flush();
  return lines.join("\n");
}
