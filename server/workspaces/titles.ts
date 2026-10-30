// Names out of meeting titles, and the name normalisation every people match uses. Pure, no
// database. Zoom titles follow "<Name>: <Topic>" for booked calls ("Ryan Meagher: AnotherStory
// Assessment", sometimes with a stray space: "Allan Lajeunesse : AnotherStory Assessment"), and
// "Ben and <Name> [about …]" / "Meeting with <Name>" / "<Name> and Benjamin Strout" for the rest.

export interface ParsedTitle {
  /** People named in the title, Ben left out, in title order, display-cased ("LUCAS SELTZER" -> "Lucas Seltzer"). */
  names: string[];
  /** What the meeting was about, when the title says ("AnotherStory Assessment"). */
  topic: string | null;
  /** The title with whitespace normalised (single spaces, "Name : Topic" -> "Name: Topic"). */
  normalized: string;
}

/** Ben's own names: never "the other participant". */
export const OWNER_NAME_KEYS = new Set(["ben", "benjamin", "ben strout", "benjamin strout", "strout"]);

const STOP_WORDS = new Set([
  "meeting", "call", "zoom", "intro", "chat", "talk", "sync", "review", "training", "coaching", "team", "weekly", "q&a",
  "classes", "planning", "prayer", "executive", "sales", "assessment", "anotherstory", "another", "story", "with", "about",
  "to", "for", "and", "the", "of", "on", "re", "discussion", "project", "scope", "onboarding", "delivery", "feasibility",
  "study", "connect", "catch", "up", "follow", "followup", "check", "in", "live", "tiktok", "content", "branding",
  "personal", "room", "my", "s", "intake", "kickoff", "kick", "off", "consult", "consultation", "meet", "alignment",
]);

/** Collapses whitespace and fixes the "Name : Topic" spacing. */
export function normalizeTitle(title: string | null | undefined): string {
  return String(title ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+:\s*/g, ": ")
    .trim();
}

/** "LUCAS SELTZER" / "lucas seltzer" -> "Lucas Seltzer"; mixed case ("McGuire", "DeAngelo") is kept. */
export function displayName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n;
  return n.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Lowercase, accents and punctuation off, single spaces: "José  O'Neil-Smith" -> "jose oneil smith". */
export function normalizeName(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** First and last token: "lucas c seltzer" and "lucas seltzer" share "lucas seltzer". Null for a one-word name. */
export function firstLastKey(name: string | null | undefined): string | null {
  const parts = normalizeName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

export function isOwnerName(name: string): boolean {
  return OWNER_NAME_KEYS.has(normalizeName(name));
}

/** A plausible person name: 1-4 words, each starting with a letter, none a common title word, no digits. */
export function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 60 || /\d/.test(t) || /[@#/&?!]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every((w) => /^\p{L}[\p{L}'’.-]*$/u.test(w))) return false;
  if (words.some((w) => STOP_WORDS.has(w.toLowerCase().replace(/[’']s$/, "")))) return false;
  // Every word capitalised ("Harwell bids" is not a name), unless the whole thing is one case ("LUCAS SELTZER", "nea").
  if (t === t.toUpperCase() || t === t.toLowerCase()) return true;
  return words.every((w) => /^\p{Lu}/u.test(w));
}

function splitPeople(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\band\b|\+)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseTitle(title: string | null | undefined): ParsedTitle {
  const normalized = normalizeTitle(title);
  const out: ParsedTitle = { names: [], topic: null, normalized };
  if (!normalized) return out;
  const push = (n: string) => {
    const name = displayName(n.replace(/[’']s$/, "").trim());
    if (!name || isOwnerName(name) || !looksLikeName(name)) return;
    if (!out.names.some((x) => normalizeName(x) === normalizeName(name))) out.names.push(name);
  };

  // 1. "<Name>: <Topic>" (Calendly / booking-page meetings).
  const colon = normalized.match(/^([^:]{2,60}):\s*(.+)$/);
  if (colon && splitPeople(colon[1]).every(looksLikeName)) {
    for (const n of splitPeople(colon[1])) push(n);
    out.topic = colon[2].trim() || null;
    return out;
  }

  // 2. "Meeting with X", "Intro call with Ben and X", "Call with X".
  const withM = normalized.match(/\bwith\s+(.+?)(?:\s+(?:about|to|re|regarding|for|on)\b.*)?$/i);
  if (withM) {
    const names = splitPeople(withM[1].replace(/\s+of\s+.*$/i, ""));
    if (names.some(looksLikeName)) {
      names.forEach(push);
      const topic = normalized.slice(0, withM.index).trim();
      out.topic = topic || null;
      return out;
    }
  }

  // 3. "Ben and X [about|to …]", "X and Benjamin Strout", "Ben Jeremy and Nathan", "Tyrik Zeigler, Dayton Contractor Discussion".
  const head = normalized.split(/\s+(?:about|to|re|regarding|for|on|chat|talk|discuss|meet|-|–|—)\s+/i)[0];
  const rest = normalized.slice(head.length).replace(/^\s*(?:about|to|re|regarding|for|on|-|–|—)\s+/i, "").trim();
  const words = head.split(/\s+/);
  // "Ben Jeremy and Nathan": a leading owner name followed by more names without a separator.
  const candidates = splitPeople(head).flatMap((p) => (isOwnerName(p.split(/\s+/)[0]) && p.split(/\s+/).length > 1 && !isOwnerName(p) ? [p.split(/\s+/)[0], p.split(/\s+/).slice(1).join(" ")] : [p]));
  const named = candidates.filter(looksLikeName);
  if (named.length && (named.length === candidates.length || /\band\b|,/i.test(head))) {
    for (const n of named) push(n);
    if (out.names.length || named.some(isOwnerName)) {
      out.topic = rest || (named.length < candidates.length ? candidates.filter((c) => !looksLikeName(c)).join(", ") : null) || null;
      return out;
    }
  }
  // 4. A bare name ("Naaim Masri", "Stephanie Levy").
  if (words.length >= 2 && looksLikeName(normalized)) {
    push(normalized);
    return out;
  }
  // 5. A leading full name before the topic words: "Rick Elliot Intake Call", "Lindsey Walters Feasibility Study Onboarding Meeting".
  const lead: string[] = [];
  for (const w of words) {
    if (!/^\p{Lu}[\p{L}'’.-]*$/u.test(w) || STOP_WORDS.has(w.toLowerCase())) break;
    lead.push(w);
  }
  if (lead.length >= 2 && lead.length <= 3 && lead.length < words.length) {
    push(lead.join(" "));
    out.topic = words.slice(lead.length).join(" ") || null;
  }
  return out;
}
