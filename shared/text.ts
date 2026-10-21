// Small text helpers shared by server and client.

const GENERIC_TITLE_PATTERNS: RegExp[] = [
  /zoom meeting/i,
  /personal meeting room/i,
  /^\s*[0-9a-f]{8,}\s*$/i, // bare hex string (a vault id or hash)
  /^\s*IMG[_-]?\d+/i, // iPhone camera roll names
  /^\s*(untitled|new recording|recording)\s*\d*\s*$/i,
  /^\s*\d{4}-\d{2}-\d{2}[ _T-]?\d{0,2}[.:_-]?\d{0,2}[.:_-]?\d{0,2}\s*$/, // bare timestamps like 2024-03-01 10.02.11
];

export function isGenericTitle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return true;
  return GENERIC_TITLE_PATTERNS.some((re) => re.test(title));
}

const FILLER = /^(ok(ay)?|yeah|yes|no|hi|hello|hey|um+|uh+|right|so|alright|all right|thanks?|thank you|recording in progress|this meeting is being recorded)[.!?,\s]*$/i;

/** First line of text that reads like a real sentence (not "Okay." or "Recording in progress"). */
export function firstMeaningfulLine(text: string | null | undefined, minChars = 24): string | null {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    // Transcript lines look like "Speaker 1: text" or "Ben Strout: text".
    const m = /^([^:]{1,60}):\s+(.*)$/.exec(line);
    if (m) line = m[2].trim();
    if (line.length < minChars) continue;
    if (FILLER.test(line)) continue;
    return line.length > 220 ? line.slice(0, 217).trimEnd() + "…" : line;
  }
  return null;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
}

/** mm:ss or h:mm:ss timestamp for transcript lines. */
export function formatTimestamp(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  return base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || filename;
}
