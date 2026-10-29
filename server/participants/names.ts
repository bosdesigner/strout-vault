// Names as they appear in recording titles, calendar invites and contact cards, and how two of
// them compare. Pure functions, no database, so the rules are unit-tested on their own.
//
//   parseTitleNames   "Tanner Durfee: AnotherStory Assessment" -> ["Tanner Durfee"]
//                     "Allan Lajeunesse : AnotherStory Assessment" (stray space) -> ["Allan Lajeunesse"]
//                     "MARA SELBY: …" -> ["Mara Selby"]; "Nolan Hart and Benjamin Strout" -> ["Nolan Hart"]
//                     "Ben and Noa" -> ["Noa"]; "Meeting with Jon Tavers" -> ["Jon Tavers"]; "Call with Dev" -> ["Dev"]
//   normalizeName     lowercase, accents and punctuation off, middle initials dropped ("Mara J. Selby" -> "mara selby")
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
    .replace(/['’]s\b/g, "") // "Ben Strout's" is Ben
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/['-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1) // middle initials ("c", "j") and stray letters
    .join(" ")
    .trim();
}

/** "MARA SELBY" -> "Mara Selby"; mixed case is kept ("McGuire", "DeShawn"). */
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
  if (words.some((w) => ORG_WORDS.has(w) || FUNCTION_WORDS.has(w))) return false;
  return words.every((w) => /^[a-z]+$/.test(w)) && !words.some((w) => ["meeting", "call", "zoom", "assessment", "story", "training", "coaching", "branding", "content", "class", "classes", "live", "planning", "prayer"].includes(w));
}

/** Words that make a contact or title a company, not a person ("Brisco Steel", "Gulf Coast Millwork"). */
const ORG_WORDS = new Set(
  "llc inc co corp company development developments architect companies group steel construction constructions builders builder building buildings homes home roofing roof plumbing electric electrical supply supplies services service solutions bank insurance realty properties property designs design studio studios millwork lumber concrete windows doors cabinets flooring hvac pools landscaping capital partners ventures holdings associates architecture architects engineering contracting contractors restoration remodeling exteriors interiors decks pharmacy drugs clinic dental medical school church university office team crew".split(" "),
);

/** Small words no name contains ("Ask an architect", "Ian of the CQC Home Team"). */
const FUNCTION_WORDS = new Set("a an the of to for with about my our your his her their from at by on in is are was".split(" "));

/** Splits "A, B and C" / "A & B" into names. */
function splitNames(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\+|\band\b|\bwith\b|\/)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Words that describe the meeting, not the person: trailing ones are cut ("Tanner Durfee Next Steps"). */
const TOPIC_WORDS = new Set(
  "next steps step discussion discuss review reviews feasibility study studies delivery delivered onboarding meeting meetings kickoff kick off follow followup up catch intro introduction consultation consult assessment anotherstory another story fs proposal project projects presentation interview va call chat sync update check in walkthrough walk through planning plan kick-off session training coaching class zoom design scope agreement confirmed discovery".split(" "),
);

function stripTopic(name: string): string {
  const words = name.split(/\s+/);
  while (words.length && TOPIC_WORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z-]/g, ""))) words.pop();
  return words.join(" ");
}

export interface TitleName {
  name: string;
  /**
   * The title is in a shape that names the person on purpose ("<Name>: …", "<Name>, Feasibility Study
   * …", "Call with <Name>", "Meeting with <Name>"): enough to create a new person. A weak name (picked
   * out of free text such as "Brad Jeremy Ben and John") only ever matches someone already known.
   */
  strong: boolean;
}

/**
 * The people a recording title names, Ben left out, with how firmly the title names them. Shapes:
 * "<Name>: <topic>" (stray space before the colon allowed), "<Name>, <topic>", "Call with <Name> ·
 * 2026-10-27", "Meeting with <Name>", and, weakly, "<Name> and Ben Strout", "Ben and <Name> about …",
 * "<Name> Feasibility Study Delivery". Topic words at the end of a name are cut; a candidate starting
 * with one ("Review Ketcham") is dropped; companies are never people.
 */
export function parseTitleNamesDetailed(title: string | null | undefined, ownerNames: string[] = DEFAULT_OWNER_NAMES): TitleName[] {
  let t = (title ?? "").replace(/\s+/g, " ").replace(/\s+([:,;])/g, "$1").trim();
  if (!t) return [];
  // The device ingest's own titles: "Call with Dev · 2026-10-28".
  t = t.replace(/\s+·\s+\d{4}-\d{2}-\d{2}.*$/, "").trim();
  const candidates: Array<{ text: string; strong: boolean }> = [];
  const colon = t.match(/^([^:]{2,80}):\s*\S/);
  const comma = t.match(/^([A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){1,3}), \S/);
  const withM = t.match(/^(?:(?:zoom |phone |intro )?(?:call|meeting|chat|intro|catch[- ]up|sync)|intro call)\s+with\s+(.{2,80}?)(?:\s+(?:about|to|re|regarding|for|on)\b.*)?$/i);
  if (colon) candidates.push(...splitNames(colon[1]).map((text) => ({ text, strong: true })));
  else if (withM) candidates.push(...splitNames(withM[1].replace(/\s*<>\s*/g, " and ")).map((text) => ({ text, strong: true })));
  else if (comma && !/\band\b/i.test(comma[1])) candidates.push({ text: comma[1], strong: true });
  else {
    const about = t.match(/^(.{2,80}?)\s+(?:about|to discuss|to chat about|to meet about|to talk about|to review|to connect|re:?|regarding|for)\b/i);
    const mid = t.match(/\bwith\s+(.{2,80}?)(?:\s+(?:about|to|re|regarding|for|on)\b.*)?$/i);
    const body = about?.[1] ?? mid?.[1] ?? t;
    candidates.push(...splitNames(body.replace(/\s*<>\s*/g, " and ")).map((text) => ({ text, strong: false })));
  }
  const out: TitleName[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    let name = c.text.replace(/^(?:mr|mrs|ms|dr)\.?\s+/i, "").replace(/[.'"!]+$/, "").trim();
    const stripped = stripTopic(name);
    // One word left in front of a topic ("Bellamy Feasibility Study", "Dunmore discussion") is a project or a surname, not a person.
    if (stripped !== name && !stripped.includes(" ")) continue;
    name = stripped;
    if (!name || TOPIC_WORDS.has(name.split(/\s+/)[0].toLowerCase())) continue;
    if (!looksLikeName(name) || isOwnerName(name, ownerNames) || startsWithOwner(name, ownerNames)) continue;
    // Free text must at least be written like a name (Capitalized or ALL CAPS), so "Kitchen walkthrough" is not a person.
    if (!c.strong && !name.split(/\s+/).every((w) => /^[A-Z][A-Za-z'-]*$/.test(w))) continue;
    // Free text that runs Ben's first name into others ("Nathan Ben", "Brad Jeremy Ben") is several people, not one.
    if (!c.strong && name.split(/\s+/).some((w) => isOwnerName(w, ownerNames))) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: displayName(name), strong: c.strong });
  }
  return out;
}

/** The names alone (see parseTitleNamesDetailed). */
export function parseTitleNames(title: string | null | undefined, ownerNames: string[] = DEFAULT_OWNER_NAMES): string[] {
  return parseTitleNamesDetailed(title, ownerNames).map((n) => n.name);
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
