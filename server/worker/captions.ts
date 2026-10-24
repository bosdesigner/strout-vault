// Caption lines, ASS subtitle files and the 9:16 crop, ported from
// meeting-vault's clip.py. Pure functions: the renderer in cut.ts shells out.

export interface WordTiming {
  start: number;
  end: number;
  word: string;
}

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  words?: WordTiming[] | null;
}

export interface CaptionLine {
  /** Seconds relative to the clip's start. */
  start: number;
  end: number;
  text: string;
}

export const CAPTION_FONT = "DejaVu Sans";
const CAPTION_SIZE_RATIO = 0.046; // of frame height
const CAPTION_MARGIN_RATIO = 0.15; // from the bottom
const MAX_CAPTION_CHARS = 24;
const MAX_CAPTION_WORDS = 5;
const CAPTION_GAP_SPLIT = 0.7; // seconds of silence that forces a new line
const MIN_LINE_SEC = 0.35;

export const SOCIAL_W = 1080;
export const SOCIAL_H = 1920;

/**
 * Estimate per-word times across a cue, weighted by word length. Used when a
 * transcript has no real word timings (Zoom VTT/CC): good enough to drive
 * caption timing, not claimed to be exact.
 */
export function synthesizeWords(text: string, start: number, end: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const span = Math.max(0.05, end - start);
  const weights = words.map((w) => Math.max(1, w.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTiming[] = [];
  let cursor = start;
  words.forEach((word, i) => {
    const width = span * (weights[i] / total);
    out.push({ start: cursor, end: cursor + width, word });
    cursor += width;
  });
  out[out.length - 1].end = end;
  return out;
}

/** Group word timings into short caption lines within [start, end). Times are relative to `start`. */
export function captionLines(segments: CaptionSegment[], start: number, end: number): CaptionLine[] {
  const words: WordTiming[] = [];
  for (const seg of segments) {
    if (seg.end <= start || seg.start >= end) continue;
    const timed = seg.words && seg.words.length ? seg.words : synthesizeWords(seg.text ?? "", seg.start, seg.end);
    for (const w of timed) {
      if (w.end <= start || w.start >= end) continue;
      const word = (w.word ?? "").trim();
      if (!word) continue;
      words.push({ start: Math.max(w.start, start), end: Math.min(w.end, end), word });
    }
  }
  words.sort((a, b) => a.start - b.start);

  const lines: CaptionLine[] = [];
  let current: WordTiming[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map((w) => w.word).join(" ").trim();
    if (text) lines.push({ start: current[0].start - start, end: Math.max(...current.map((w) => w.end)) - start, text });
    current = [];
  };
  for (const w of words) {
    if (current.length) {
      const gap = w.start - current[current.length - 1].end;
      const projected = current.map((x) => x.word).join(" ").length + 1 + w.word.length;
      if (gap > CAPTION_GAP_SPLIT || projected > MAX_CAPTION_CHARS || current.length >= MAX_CAPTION_WORDS) flush();
    }
    current.push(w);
  }
  flush();

  // Never let a line linger past the next one, and give very short lines a floor.
  lines.forEach((line, i) => {
    line.end = Math.max(line.end, line.start + MIN_LINE_SEC);
    if (i + 1 < lines.length) line.end = Math.min(line.end, lines[i + 1].start);
    line.start = Math.max(0, line.start);
  });
  return lines.filter((l) => l.end > l.start);
}

function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

export function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, "\\N");
}

/** A minimal, readable ASS file styled for short-form video. */
export function buildAss(lines: CaptionLine[], width: number, height: number): string {
  const size = Math.max(18, Math.round(height * CAPTION_SIZE_RATIO));
  const marginV = Math.max(20, Math.round(height * CAPTION_MARGIN_RATIO));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${CAPTION_FONT},${size},&H00FFFFFF,&H000000FF,&H00101010,&H8C000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.floor(size / 14))},${Math.max(1, Math.floor(size / 22))},2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines.map((l) => `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Cap,,0,0,0,,${assEscape(l.text)}`);
  return header + events.join("\n") + "\n";
}

/** Escape a path for use inside an ffmpeg filtergraph option value. */
export function escapeFilterPath(p: string): string {
  // Single-quoted for the filtergraph parser; the characters it treats specially inside quotes are
  // the quote itself and backslash, and ':' must be escaped for the subtitles filter's option parser.
  return "'" + p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:") + "'";
}

/** A 9:16 crop rect inside a WxH frame: [w, h, x, y]. focus 0..1 moves the window. */
export function verticalCrop(width: number, height: number, focusX = 0.5, focusY = 0.5): [number, number, number, number] {
  const target = 9 / 16;
  let cropW = Math.round(height * target);
  let cropH = height;
  if (cropW > width) {
    // Already narrower than 9:16: crop height instead.
    cropW = width;
    cropH = Math.min(height, Math.round(width / target));
  }
  cropW -= cropW % 2;
  cropH -= cropH % 2;
  let x = Math.round((width - cropW) * Math.min(1, Math.max(0, focusX)));
  let y = Math.round((height - cropH) * Math.min(1, Math.max(0, focusY)));
  x -= x % 2;
  y -= y % 2;
  return [cropW, cropH, x, y];
}
