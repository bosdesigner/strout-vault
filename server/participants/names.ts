// Names as they appear in recording titles, calendar invites and contact cards, and how two of
// them compare. Pure functions, no database, so the rules are unit-tested on their own.
//
//   parseTitleNames   "Tanner Durfee: AnotherStory Assessment" -> ["Tanner Durfee"]
//                     "Allan Lajeunesse : AnotherStory Assessment" (stray space) -> ["Allan Lajeunesse"]
//                     "LUCAS SELTZER: …" -> ["Lucas Seltzer"]; "Nathan Huff and Benjamin Strout" -> ["Nathan Huff"]
//                     "Ben and Nea" -> ["Nea"]; "Meeting with John Tabor" -> ["John Tabor"]; "Call with Devon" -> ["Devon"]
//   normalizeName     lowercase, accents and punctuation off, middle initials dropped ("Lucas C. Seltzer" -> "lucas seltzer")
//   nameDistance      edit distance between normalized names, for "Bejamin" vs "Benjamin" (a suggestion, never a merge)

/** Ben's own names: never "the other participant". OWNER_NAME and OWNER_NAME_ALIASES extend it. */
export const DEFAULT_OWNER_NAMES = ["ben", "benjamin", "ben strout", "benjamin strout", "ben s", "benjamin s"];

/** Words that look like a name in a title but are not a person. */
const NOT_A_NAME = new Set(
  [
    "another story",
    "anotherstory",
    "zoom",
    "zoom meeting",
    "meeting",
    "call",
    "call recording",
    "personal meeting room",
    "team",
    "team meeting",
    "weekly",
    "intro",
    "intro call",
    "assessment",
    "discovery call",
    "onboarding",
    "delivery",
    "feasibility study",
    "new recording",
    "voice memo",
    "untitled",
    "unknown",
    "test",
  ].map((s) => s.toLowerCase()),
);

export function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/['-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1) // middle initials ("c", "j") and stray letters
    .join(" ")
    .trim();
}

/** "LUCAS SELTZER" -> "Lucas Seltzer"; mixed case is kept ("McGuire", "DeShawn"). */
export function displayName(name: string): string {
  const t = name.replace(/\s+/g, " ").trim();
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
  return t
    .toLowerCase()
    .split(" ")
    .map((w) => w.replace(/(^|[-'])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase()))
    .join(" ");
}

export function isOwnerName(name: string, ownerNames: string[] = DEFAULT_OWNER_NAMES): boolean {
  const n = normalizeName(name);
  return !!n && ownerNames.map(normalizeName).includes(n);
}

/** "Ben Strout alignment": Ben's full name followed by a topic word. */
function startsWithOwner(name: string, ownerNames: string[]): boolean {
  const n = normalizeName(name);
  return ownerNames.map(normalizeName).some((o) => o.includes(" ") && n.startsWith(`${o} `));
}

/** A plausible person's name: letters, 1-4 words, not a generic title word, not an email or number. */
export function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 60 || /[@\d]/.test(t) || /https?:/i.test(t)) return false;
  const n = normalizeName(t);
  if (!n || NOT_A_NAME.has(n)) return false;
  const words = n.split(" ");
  if (words.length > 4) return false;
  return words.every((w) => /^[a-z]+$/.test(w)) && !words.some((w) => ["meeting", "call", "zoom", "assessment", "story", "training", "coaching", "branding", "content", "class", "classes", "live", "planning", "prayer"].includes(w));
}

/** Splits "A, B and C" / "A & B" into names. */
function splitNames(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\+|\band\b|\bwith\b|\/)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The people a recording title names, Ben left out. Recognises the shapes Ben's calendar and
 * Zoom produce: "<Name>: <topic>", "<Name> and Ben Strout", "Ben and <Name>", "Meeting with
 * <Name>", "Call with <Name> · 2026-10-27", "<Name> <> Ben". Returns display-cased names,
 * each at most once.
 */
export function parseTitleNames(title: string | null | undefined, ownerNames: string[] = DEFAULT_OWNER_NAMES): string[] {
  let t = (title ?? "").replace(/\s+/g, " ").replace(/\s+([:,;])/g, "$1").trim();
  if (!t) return [];
  // The device ingest's own titles: "Call with Devon · 2026-10-28".
  t = t.replace(/\s+·\s+\d{4}-\d{2}-\d{2}.*$/, "").trim();
  const candidates: string[] = [];
  // Outside "<Name>: …" a candidate must be written like a name (Capitalized or ALL CAPS words), so a
  // topic title ("Kitchen walkthrough", "team meeting") is never taken for a person.
  let mustLookCapitalized = false;
  const colon = t.match(/^([^:]{2,80}):\s*\S/);
  if (colon) candidates.push(...splitNames(colon[1]));
  else {
    mustLookCapitalized = true;
    const withM = t.match(/\b(?:meeting|call|chat|zoom|intro(?:duction)?|catch[- ]up|sync)\s+(?:call\s+)?with\s+(.{2,80}?)(?:\s+(?:about|to|re|regarding|for|on)\b.*)?$/i);
    const leading = t.match(/^(?:intro call with|intro with)\s+(.{2,80})$/i);
    const about = t.match(/^(.{2,80}?)\s+(?:about|to discuss|to chat about|to meet about|to connect|re:?|regarding)\b/i);
    const body = withM?.[1] ?? leading?.[1] ?? about?.[1] ?? t;
    candidates.push(...splitNames(body.replace(/\s*<>\s*/g, " and ")));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const name = c.replace(/^(?:mr|mrs|ms|dr)\.?\s+/i, "").replace(/[.'"]+$/, "").trim();
    if (!looksLikeName(name) || isOwnerName(name, ownerNames) || startsWithOwner(name, ownerNames)) continue;
    if (mustLookCapitalized && !name.split(/\s+/).every((w) => /^[A-Z][A-Za-z'-]*$/.test(w))) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(displayName(name));
  }
  return out;
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Whether two names are probably the same person spelled differently: same number of words and
 * a small edit distance overall ("Bejamin Schiavi" ~ "Benjamin Schiavi"), or the same last name with
 * a first name that is a typo or a prefix of the other ("Jon Brou" ~ "Jonathan Brou"). Exact matches
 * return false: those are not "fuzzy". A fuzzy match is only ever a suggestion for review.
 */
export function isFuzzyNameMatch(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y || x === y) return false;
  const xs = x.split(" ");
  const ys = y.split(" ");
  if (xs.length < 2 || ys.length < 2) return false;
  const lastX = xs[xs.length - 1];
  const lastY = ys[ys.length - 1];
  const firstX = xs[0];
  const firstY = ys[0];
  const d = editDistance(x, y);
  if (xs.length === ys.length && d <= Math.max(1, Math.min(2, Math.floor(Math.min(x.length, y.length) / 6)))) return true;
  if (lastX === lastY && (editDistance(firstX, firstY) <= 2 || (Math.min(firstX.length, firstY.length) >= 3 && (firstX.startsWith(firstY) || firstY.startsWith(firstX))))) return true;
  return false;
}
