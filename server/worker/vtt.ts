// WebVTT parsing for Zoom's transcript (TRANSCRIPT) and closed-caption (CC)
// files. Ported from meeting-vault's transcribe.parse_vtt: cue-level only,
// `Speaker: text` prefixes pulled out, HTML-ish tags stripped.

export interface VttCue {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

const TIME_RE = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})/;
const TAG_RE = /<[^>]+>/g;
// "Ben Strout: hello" -> speaker "Ben Strout". Capped so a sentence with a
// colon in it ("Note: this is fine") is not mistaken for a speaker label.
const SPEAKER_RE = /^([^:\n]{1,60}?):\s+(.*)$/s;

function hms(h: string | undefined, m: string, s: string, ms: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

export function parseVtt(raw: string): VttCue[] {
  const cues: VttCue[] = [];
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (let block of text.split(/\n\s*\n/)) {
    block = block.trim();
    if (!block || block.toUpperCase().startsWith("WEBVTT") || block.startsWith("NOTE")) continue;
    const lines = block.split("\n");
    const timingIdx = lines.findIndex((l) => TIME_RE.test(l));
    if (timingIdx < 0) continue;
    const m = TIME_RE.exec(lines[timingIdx])!;
    const start = hms(m[1], m[2], m[3], m[4]);
    let end = hms(m[5], m[6], m[7], m[8]);
    let body = lines
      .slice(timingIdx + 1)
      .map((l) => l.trim())
      .join(" ")
      .replace(TAG_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    let speaker: string | null = null;
    const sm = SPEAKER_RE.exec(body);
    if (sm) {
      speaker = sm[1].trim();
      body = sm[2].trim();
      if (!body) continue;
    }
    if (end <= start) end = start + 0.5;
    cues.push({ start, end, speaker, text: body });
  }
  return cues;
}

/** Plain-text transcript in the shape the app already stores in interactions.transcript. */
export function cuesToPlainText(cues: Array<{ start: number; speaker: string | null; text: string }>): string {
  return cues
    .map((c) => {
      const t = formatStamp(c.start);
      return c.speaker ? `[${t}] ${c.speaker}: ${c.text}` : `[${t}] ${c.text}`;
    })
    .join("\n");
}

function formatStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
