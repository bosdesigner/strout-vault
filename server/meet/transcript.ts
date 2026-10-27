// Google Meet's transcript Doc, exported as plain text, into timed segments. The Doc looks like:
//
//   Weekly sync - Transcript
//   Attendees
//   Ben Strout, Kevin McGuire
//   Transcript
//   00:00:00
//   Ben Strout: Morning. Are we still on for Conroe?
//   Kevin McGuire: Yes, sunrise.
//   00:05:00
//   ...
//
// Timestamps appear every few minutes, not per line, so lines between two stamps get times spread
// across the gap in proportion to their length. Anything before the first stamp (title, attendee
// list, Gemini notes) is metadata, never a segment.

export interface MeetSegment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

export interface ParsedMeetTranscript {
  segments: MeetSegment[];
  speakers: string[];
  attendees: string[];
  durationSec: number | null;
}

const STAMP = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/;
const LINE = /^\s*([^:\n]{1,80}?):\s+(.+)$/;
const FOOTER = /^(this editable transcript was computer generated|transcription ended after|meeting ended after)/i;

function stampSec(m: RegExpExecArray): number {
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseMeetTranscript(text: string, durationHint?: number | null): ParsedMeetTranscript {
  const lines = text.replace(/\r\n/g, "\n").replace(/﻿/g, "").split("\n");
  const attendees: string[] = [];
  const blocks: Array<{ at: number; lines: Array<{ speaker: string | null; text: string }> }> = [];
  let seenStamp = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!seenStamp && /^attendees$/i.test(line)) {
      const next = (lines[i + 1] ?? "").trim();
      attendees.push(...next.split(",").map((s) => s.trim()).filter(Boolean));
      i++;
      continue;
    }
    const stamp = STAMP.exec(line);
    if (stamp) {
      seenStamp = true;
      blocks.push({ at: stampSec(stamp), lines: [] });
      continue;
    }
    if (!seenStamp || FOOTER.test(line)) continue;
    const m = LINE.exec(line);
    const block = blocks[blocks.length - 1];
    if (m) block.lines.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (block.lines.length) block.lines[block.lines.length - 1].text += ` ${line}`;
    else block.lines.push({ speaker: null, text: line });
  }
  const segments: MeetSegment[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const { at, lines: ls } = blocks[b];
    if (!ls.length) continue;
    const nextAt = blocks[b + 1]?.at ?? Math.max(at + ls.length * 6, durationHint ?? 0);
    const span = Math.max(1, nextAt - at);
    const total = ls.reduce((n, l) => n + l.text.length, 0) || 1;
    let t = at;
    for (const l of ls) {
      const len = (span * l.text.length) / total;
      segments.push({ start: round(t), end: round(t + len), speaker: l.speaker, text: l.text });
      t += len;
    }
  }
  const speakers = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => !!s))];
  return { segments, speakers, attendees, durationSec: segments.length ? Math.ceil(segments[segments.length - 1].end) : null };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** "Weekly sync (2026-10-20 14:03 GMT-5) - Transcript" -> "Weekly sync (2026-10-20 14:03 GMT-5)". */
export function meetBaseName(name: string): string {
  return name
    .replace(/\.(mp4|m4a|webm)$/i, "")
    .replace(/\s*[-–]\s*(transcript|recording|notes by gemini|chat)\s*$/i, "")
    .trim()
    .toLowerCase();
}
