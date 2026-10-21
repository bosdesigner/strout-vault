// Generates db/seed.sql: realistic fake data for local development and tests.
// Deterministic (seeded PRNG) so the committed file is reproducible:
//   npx tsx scripts/gen-seed.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/seed.sql");

// ---------------------------------------------------------------- prng --
let seed = 20261021;
function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const between = (a: number, b: number) => a + rnd() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) {
    if (v.some((x) => x !== null && typeof x === "object")) return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    return `array[${v.map((x) => q(x)).join(",")}]::text[]`;
  }
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");

// ---------------------------------------------------------- reference --
const workspaces = [
  { id: "another_story", name: "Another Story", notes: "Video production: brand stories, shoot days, edits." },
  { id: "phalanx", name: "Phalanx", notes: "Security consulting pilot." },
  { id: "strout_arch", name: "Strout Architecture", notes: "Residential architecture: additions, remodels, new builds." },
  { id: "southern_shutter", name: "Southern Shutter", notes: "Custom exterior shutters and millwork." },
  { id: "sepp", name: "SEPP", notes: "Small energy projects partnership." },
  { id: "credvault", name: "CredVault", notes: "Credential vault startup." },
];

interface Party {
  id: number;
  kind: "person" | "org";
  name: string;
  emails?: string[];
  phones?: string[];
  location?: string;
  website?: string;
  notes?: string;
}
const parties: Party[] = [
  { id: 1, kind: "person", name: "Ben Strout", emails: ["ben@example.com"], location: "Houston, TX" },
  { id: 2, kind: "person", name: "Kevin McGuire", emails: ["kevin.mcguire@example.com"], phones: ["+1 936 555 0142"], location: "Conroe, TX" },
  { id: 3, kind: "person", name: "Maria Delgado", emails: ["maria.delgado@example.com"], phones: ["+1 713 555 0187"], location: "Houston Heights, TX" },
  { id: 4, kind: "person", name: "Tom Ashworth", emails: ["tom.ashworth@example.com"], phones: ["+1 281 555 0133"], location: "The Woodlands, TX" },
  { id: 5, kind: "person", name: "Priya Natarajan", emails: ["priya@harborpoint.example.com"], location: "Austin, TX" },
  { id: 6, kind: "person", name: "Daniel Okafor", emails: ["daniel.okafor@example.com"], location: "Dallas, TX" },
  { id: 7, kind: "person", name: "Lena Fischer", emails: ["lena@gulfcoastmillwork.example.com"], phones: ["+1 409 555 0199"], location: "Galveston, TX" },
  { id: 8, kind: "org", name: "Gulf Coast Millwork", website: "https://gulfcoastmillwork.example.com", location: "Galveston, TX" },
  { id: 9, kind: "org", name: "Harbor Point Capital", website: "https://harborpoint.example.com", location: "Austin, TX" },
  { id: 10, kind: "person", name: "Sam Whitaker", emails: ["sam.whitaker@example.com"], phones: ["+1 512 555 0121"], location: "Austin, TX" },
  { id: 11, kind: "person", name: "Rachel Kim", emails: ["rachel.kim@example.com"], location: "Houston, TX" },
  { id: 12, kind: "org", name: "Oakridge Builders", website: "https://oakridgebuilders.example.com", location: "Houston, TX" },
  { id: 13, kind: "person", name: "Carlos Mendes", emails: ["carlos@oakridgebuilders.example.com"], phones: ["+1 832 555 0170"], location: "Houston, TX" },
  { id: 14, kind: "person", name: "Jordan Ellis", emails: ["jordan.ellis@example.com"], location: "Plano, TX" },
  { id: 15, kind: "person", name: "Nora Bennett", emails: ["nora.bennett@example.com"], phones: ["+1 512 555 0164"], location: "Austin, TX" },
  { id: 16, kind: "org", name: "Bayou City Permits", website: "https://bayoucitypermits.example.com", location: "Houston, TX" },
];
const P = Object.fromEntries(parties.map((p) => [p.name, p.id])) as Record<string, number>;

const roles = [
  ...workspaces.map((w) => ({ ws: w.id, party: P["Ben Strout"], role: "team", status: "active", market: null as string | null, detail: "owner" as string | null })),
  { ws: "another_story", party: P["Kevin McGuire"], role: "contractor", status: "active", market: "Houston (Conroe)", detail: "camera operator, drone" },
  { ws: "another_story", party: P["Sam Whitaker"], role: "contractor", status: "active", market: "Austin", detail: "editor" },
  { ws: "strout_arch", party: P["Maria Delgado"], role: "client", status: "active", market: "Houston (Heights)", detail: "bungalow addition" },
  { ws: "strout_arch", party: P["Nora Bennett"], role: "client", status: "prospect", market: "Austin", detail: "lake house" },
  { ws: "strout_arch", party: P["Oakridge Builders"], role: "partner", status: "active", market: "Houston", detail: "general contractor" },
  { ws: "strout_arch", party: P["Carlos Mendes"], role: "contractor", status: "active", market: "Houston", detail: "site super at Oakridge" },
  { ws: "strout_arch", party: P["Bayou City Permits"], role: "vendor", status: "active", market: "Houston", detail: "permit expediting" },
  { ws: "southern_shutter", party: P["Tom Ashworth"], role: "client", status: "active", market: "The Woodlands", detail: "porch shutters" },
  { ws: "southern_shutter", party: P["Gulf Coast Millwork"], role: "vendor", status: "active", market: "Gulf Coast", detail: "cedar and cypress stock" },
  { ws: "southern_shutter", party: P["Lena Fischer"], role: "vendor", status: "active", market: "Gulf Coast", detail: "account manager at Gulf Coast Millwork" },
  { ws: "credvault", party: P["Priya Natarajan"], role: "investor", status: "active", market: "Austin", detail: "partner at Harbor Point" },
  { ws: "credvault", party: P["Harbor Point Capital"], role: "investor", status: "active", market: "Austin", detail: "seed lead" },
  { ws: "phalanx", party: P["Daniel Okafor"], role: "partner", status: "active", market: "Dallas", detail: "co-founder" },
  { ws: "phalanx", party: P["Jordan Ellis"], role: "prospect", status: "prospect", market: "Dallas", detail: "pilot customer" },
  { ws: "sepp", party: P["Rachel Kim"], role: "advisor", status: "active", market: "Houston", detail: "energy policy" },
];

const affiliations = [
  { person: P["Lena Fischer"], org: P["Gulf Coast Millwork"], title: "Account manager" },
  { person: P["Priya Natarajan"], org: P["Harbor Point Capital"], title: "Partner" },
  { person: P["Carlos Mendes"], org: P["Oakridge Builders"], title: "Site superintendent" },
];

const projects = [
  { id: 1, ws: "strout_arch", name: "Heights Bungalow Addition", address: "1412 Harvard St, Houston, TX", status: "construction", parties: [[P["Maria Delgado"], "client"], [P["Oakridge Builders"], "gc"], [P["Carlos Mendes"], "site_super"]] },
  { id: 2, ws: "southern_shutter", name: "Ashworth Porch Shutters", address: "The Woodlands, TX", status: "fabrication", parties: [[P["Tom Ashworth"], "client"], [P["Gulf Coast Millwork"], "vendor"]] },
  { id: 3, ws: "credvault", name: "CredVault Seed Round", address: null, status: "active", parties: [[P["Priya Natarajan"], "investor"], [P["Harbor Point Capital"], "investor"]] },
  { id: 4, ws: "another_story", name: "Conroe Shoot Day", address: "Conroe, TX", status: "scheduled", parties: [[P["Kevin McGuire"], "crew"]] },
  { id: 5, ws: "phalanx", name: "Phalanx Pilot", address: null, status: "proposal", parties: [[P["Daniel Okafor"], "partner"], [P["Jordan Ellis"], "prospect"]] },
  { id: 6, ws: "strout_arch", name: "Bennett Lake House", address: "Lake Travis, TX", status: "schematic", parties: [[P["Nora Bennett"], "client"]] },
] as const;

// ------------------------------------------------------------ dialogue --
const general = [
  "Let me share my screen so we are looking at the same thing.",
  "Can everyone hear me okay? The audio dropped for a second there.",
  "I will send a follow-up email with the notes after this call.",
  "Let's circle back to that at the end if we have time.",
  "What does the timeline look like from your side?",
  "I think the realistic date is the end of next month, not this one.",
  "That makes sense to me. Let's write that down as a decision.",
  "Give me one second, I am pulling up the file.",
  "The short version is that we are on budget but about two weeks behind.",
  "Who owns that next step? I want to make sure it does not fall through the cracks.",
  "I would rather we over-communicate on this one than surprise anyone later.",
  "Before we wrap, is there anything else on your list?",
  "I will put the invoice together this week and send it over for review.",
  "Can you send me the latest version so I am not marking up an old one?",
  "We lost about a day to the weather but it should not move the delivery date.",
  "Let's keep this meeting to thirty minutes if we can.",
  "The number I quoted earlier was an estimate; the firm price comes after the site visit.",
  "I will confirm with the team and get back to you by Thursday.",
  "If that changes, flag it early and we will adjust the plan.",
  "That is a good question. I do not know yet, but I can find out.",
];
const pools: Record<string, string[]> = {
  strout_arch: [
    "The structural engineer wants to see the foundation plan before he signs off on the beam sizes.",
    "We need the structural drawings for the Heights bungalow before Friday or the permit slips a cycle.",
    "The permit office in Conroe asked for a revised site plan showing the drainage easement.",
    "Bayou City Permits said the plan review is running about three weeks right now.",
    "I would move the kitchen window to line up with the dining room so the elevation reads cleaner.",
    "The clients want a mudroom off the garage with a bench and cubbies for the kids.",
    "Let's keep the roof pitch at six over twelve so it matches the original bungalow.",
    "The copper gutters are a line item the owner may want to cut if we are over budget.",
    "We can do standing seam metal on the addition and keep the composition shingles on the main house.",
    "The skylight over the stair gets a lot of afternoon heat; I would rather do a clerestory.",
    "The dormer on the north side adds headroom in the attic bedroom without changing the front elevation.",
    "Oakridge priced the framing package at about forty two thousand including labor.",
    "Carlos said the concrete pour is scheduled for Tuesday as long as the inspection passes Monday.",
    "The setback on the east side is five feet, so the addition has to stop at the existing wall line.",
    "I will redline the sheet set tonight and send the PDF for your comments.",
    "The plumbing rough-in needs to move eight inches to clear the new footing.",
    "Hardie board on the new walls and we match the lap exposure on the old siding.",
    "The lake house wants big glass on the water side and almost nothing on the road side.",
    "Nora asked whether a screened porch could wrap the corner of the living room.",
    "Energy code wants the attic at R38 if we insulate the ceiling, or we foam the roof deck.",
  ],
  southern_shutter: [
    "The cedar shutters for the back porch should be board and batten with a one inch gap.",
    "Gulf Coast Millwork has cypress in stock but the cedar is on a three week lead time.",
    "Tom wants the shutters painted Charleston green to match the front door.",
    "Each pair runs about six hundred eighty dollars installed with the stainless hinges.",
    "Lena said the mill can rip the stock to five and a quarter if we need the narrower boards.",
    "The porch has eight openings so we are looking at sixteen panels total.",
    "We should use the operable hardware on the porch and fixed mounts on the dormer windows.",
    "I will measure the openings again before the order goes in; the house is not square.",
    "The copper gutters on the porch roof will patina, so the shutters should not fight with that.",
    "If we go with cypress instead of cedar the price drops about twelve percent.",
    "Install is two days with two guys, weather permitting.",
    "The shutter dogs come in black iron or brass; brass looks better with the green.",
  ],
  another_story: [
    "The Conroe shoot day starts at sunrise so we can get the drone pass before the wind picks up.",
    "Kevin is bringing the second camera body and the long lens for the interview setup.",
    "We need release forms signed before anyone is on camera.",
    "The client wants a ninety second cut for the website and three fifteen second cuts for social.",
    "Sam can start the edit Monday once the footage is backed up to the drive and the cloud.",
    "The brand story should open on the founder walking the shop floor, not on a talking head.",
    "Day rate for the shoot is fifteen hundred plus mileage and the drone add-on.",
    "The audio from the lav mic was clean but the room tone had an air conditioner hum.",
    "Let's schedule the color pass after the client approves the rough cut.",
    "I would like to deliver the final files in both ProRes and H.264.",
    "The copper gutters on the warehouse caught the light nicely in the drone footage.",
  ],
  credvault: [
    "Harbor Point wants to lead the seed round at a six million pre-money valuation.",
    "Priya asked for the updated pipeline numbers and the churn by cohort.",
    "The vault stores credentials encrypted at rest with per-tenant keys.",
    "We are at eleven paying customers and about fourteen thousand in monthly recurring revenue.",
    "The term sheet has a one times liquidation preference and a standard pro rata right.",
    "Hiring plan is two engineers and one customer success hire in the first six months.",
    "The SOC 2 audit should finish in the second quarter if we start the readiness work now.",
    "Enterprise prospects keep asking about single sign-on and audit logs.",
    "Let's close the round by the end of the quarter so we are not fundraising through the summer.",
    "The data room has the cap table, the financial model and the customer contracts.",
  ],
  phalanx: [
    "The pilot would cover one site for ninety days with a fixed fee of twenty thousand.",
    "Daniel will write the statement of work and I will handle the pricing section.",
    "Jordan's team wants a tabletop exercise in the first month and a report at the end.",
    "The access control review found three doors that do not log badge events.",
    "We should scope the pilot narrowly so it is easy to say yes to.",
    "The proposal goes to their security committee on the fifteenth.",
    "Let's include a reference call with the Dallas client in the proposal.",
    "If the pilot goes well the annual contract is roughly one hundred twenty thousand.",
  ],
  sepp: [
    "Rachel suggested we apply for the state efficiency grant before the window closes in March.",
    "The solar array on the community center pencils out at a seven year payback.",
    "The utility rebate covers about thirty percent of the LED retrofit cost.",
    "We need a letter of support from the county for the grant application.",
    "The partnership agreement should spell out who owns the equipment after year ten.",
    "Battery storage does not make sense at these rates yet, but it might next year.",
  ],
};

// --------------------------------------------------------- recordings --
interface Rec {
  id: number;
  ws: string | null;
  source: "zoom" | "upload" | "iphone_call";
  title: string;
  occurredAt: Date;
  durationSec: number;
  participants: number[]; // party ids
  speakers: Array<{ label: string; partyId: number | null }>;
  pipeline: string | null;
  pipelineError?: string | null;
  tags: string[];
  summary: string | null;
  media: Array<{ storage: string; bucket: string | null; key: string; role: string; kind: string; status: string; bytes: number; mime: string | null; sha?: string | null }>;
  playableSample?: number;
  projectId?: number;
  seedPhraseAt?: Array<{ at: number; text: string; speakerIdx?: number }>;
}

const WS_PEOPLE: Record<string, number[]> = {
  strout_arch: [P["Maria Delgado"], P["Carlos Mendes"], P["Nora Bennett"]],
  southern_shutter: [P["Tom Ashworth"], P["Lena Fischer"]],
  another_story: [P["Kevin McGuire"], P["Sam Whitaker"]],
  credvault: [P["Priya Natarajan"]],
  phalanx: [P["Daniel Okafor"], P["Jordan Ellis"]],
  sepp: [P["Rachel Kim"]],
};
const WS_PROJECT: Record<string, number> = { strout_arch: 1, southern_shutter: 2, credvault: 3, another_story: 4, phalanx: 5 };
const nameOf = (id: number) => parties.find((p) => p.id === id)!.name;

const titled: Array<[string, string, Rec["source"]]> = [
  ["strout_arch", "Heights bungalow: beam sizes and permit set", "zoom"],
  ["strout_arch", "Delgado kitchen window review", "zoom"],
  ["strout_arch", "Oakridge framing walkthrough", "upload"],
  ["strout_arch", "Bennett lake house kickoff", "zoom"],
  ["strout_arch", "Permit status with Bayou City", "iphone_call"],
  ["southern_shutter", "Ashworth porch shutters: measure and quote", "zoom"],
  ["southern_shutter", "Gulf Coast Millwork stock check", "iphone_call"],
  ["southern_shutter", "Shutter hardware options", "zoom"],
  ["another_story", "Conroe shoot day planning", "zoom"],
  ["another_story", "Rough cut review with Sam", "zoom"],
  ["another_story", "Kevin: drone pass and call time", "iphone_call"],
  ["credvault", "Harbor Point seed terms", "zoom"],
  ["credvault", "CredVault pipeline review", "zoom"],
  ["credvault", "SOC 2 readiness planning", "zoom"],
  ["phalanx", "Phalanx pilot scope with Daniel", "zoom"],
  ["phalanx", "Jordan Ellis intro call", "zoom"],
  ["sepp", "SEPP grant application strategy", "zoom"],
  ["sepp", "Community center solar numbers", "upload"],
  ["strout_arch", "Site visit: concrete pour prep", "upload"],
  ["strout_arch", "Clerestory versus skylight", "zoom"],
  ["southern_shutter", "Charleston green paint sample", "upload"],
  ["another_story", "Brand story outline", "zoom"],
  ["credvault", "Enterprise SSO requests", "zoom"],
  ["phalanx", "Tabletop exercise debrief", "zoom"],
  ["strout_arch", "Dormer and attic bedroom options", "zoom"],
  ["another_story", "Color pass sign-off", "zoom"],
  ["strout_arch", "Mudroom layout with Maria", "zoom"],
  ["sepp", "Battery storage check-in with Rachel", "iphone_call"],
];
const genericTitles = [
  "Ben Strout's Zoom Meeting",
  "Ben Strout's Personal Meeting Room",
  "Zoom Meeting",
  "IMG_4821",
  "IMG_5310",
  "a91f3c0d7e2b48f6",
  "Ben Strout's Zoom Meeting",
  "2024-06-11 14.02.11",
];

const recs: Rec[] = [];
let recId = 1;
const start = new Date("2023-01-10T15:00:00Z").getTime();
const end = new Date("2026-10-15T15:00:00Z").getTime();
const total = titled.length + genericTitles.length + 4; // 40
const times = Array.from({ length: total }, (_, i) => start + ((end - start) * (i + rnd() * 0.6)) / total).sort((a, b) => a - b);
let ti = 0;

function mkRec(ws: string | null, title: string, source: Rec["source"], extra: Partial<Rec> = {}): Rec {
  const occurredAt = new Date(times[ti++]);
  occurredAt.setUTCMinutes(pick([0, 0, 30, 30, 15, 45]), 0, 0);
  const wsKey = ws ?? pick(Object.keys(pools));
  const people = ws ? [...WS_PEOPLE[ws]] : [pick(WS_PEOPLE[wsKey])];
  const others = people.slice(0, source === "iphone_call" ? 1 : int(1, Math.min(2, people.length)));
  const participants = [P["Ben Strout"], ...others];
  const speakers: Rec["speakers"] =
    source === "zoom"
      ? participants.map((id) => ({ label: nameOf(id), partyId: id }))
      : participants.map((id, i) => ({ label: `Speaker ${i + 1}`, partyId: i === 0 ? id : null }));
  const durationSec = source === "iphone_call" ? int(240, 1500) : int(900, 4500);
  const r: Rec = {
    id: recId++,
    ws,
    source,
    title,
    occurredAt,
    durationSec,
    participants,
    speakers,
    pipeline: null,
    tags: [],
    summary: null,
    media: [],
    ...extra,
  };
  if (ws && WS_PROJECT[ws] && rnd() < 0.7) r.projectId = WS_PROJECT[ws];
  return r;
}

for (const [ws, title, source] of titled) recs.push(mkRec(ws, title, source));
for (const title of genericTitles) {
  const source: Rec["source"] = /^IMG/.test(title) ? "upload" : /^\d{4}-/.test(title) ? "upload" : "zoom";
  recs.push(mkRec(pick(workspaces).id, title, source));
}
// Three recordings playable through the local driver (2-minute WebM samples; VP9 so headless Chromium can play them too).
recs.push(mkRec("another_story", "Kevin: quick check on the Conroe call time", "iphone_call", { playableSample: 1, durationSec: 120 }));
recs.push(mkRec("strout_arch", "Pool house tile sample walkthrough", "upload", { playableSample: 2, durationSec: 120 }));
recs.push(mkRec("southern_shutter", "Porch measure notes (phone)", "iphone_call", { playableSample: 3, durationSec: 120 }));
// One upload still in the pipeline and one failure, so status chips show up.
recs.push(mkRec("another_story", "Warehouse b-roll selects", "upload", { pipeline: "transcribing" }));

recs.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
recs.forEach((r, i) => (r.id = i + 1));

// Pipeline statuses: legacy rows null (= ready), newer ones 'ready', a couple in flight.
for (const r of recs) {
  if (r.pipeline) continue;
  r.pipeline = r.occurredAt.getTime() > new Date("2026-06-01").getTime() ? "ready" : null;
}
const failed = recs.find((r) => r.source === "upload" && !r.playableSample && r.pipeline !== "transcribing" && r.id > 30);
if (failed) {
  failed.pipeline = "failed";
  failed.pipelineError = "ffmpeg: moov atom not found (file truncated during upload)";
}
const queued = recs.filter((r) => r.source === "zoom" && r.id > 34).slice(-1)[0];
if (queued) queued.pipeline = "queued";

// Seed phrases the end-to-end tests search for, at known timestamps.
for (const r of recs) {
  if (r.playableSample === 2) {
    r.seedPhraseAt = [{ at: 42, text: "Let's use the pelican roof tiles sample for the pool house and see how it reads against the stucco.", speakerIdx: 0 }];
  }
  if (r.playableSample === 1) {
    r.seedPhraseAt = [{ at: 31, text: "Call time is six fifteen at the warehouse gate; bring the long lens and the spare drone batteries.", speakerIdx: 1 }];
  }
  if (r.playableSample === 3) {
    r.seedPhraseAt = [{ at: 55, text: "The porch openings measure thirty one and a half by seventy two, and the house is not square.", speakerIdx: 0 }];
  }
}

// Tags and summaries.
const tagPool = ["client", "pricing", "permit", "schedule", "decision", "follow-up", "investor", "crew", "vendor", "site-visit"];
for (const r of recs) {
  const n = int(0, 3);
  r.tags = [...new Set(Array.from({ length: n }, () => pick(tagPool)))];
  if (r.pipeline === "transcribing" || r.pipeline === "queued" || r.pipeline === "failed") continue;
  const pool = pools[r.ws ?? "strout_arch"];
  r.summary = rnd() < 0.7 ? `${pick(pool)} ${pick(general)}` : null;
}

// ------------------------------------------------------------- media --
const B2 = "anotherstory-meeting-vault";
const R2 = "strout-vault";
const macRoot = "/Volumes/Toshiba/meeting-vault";
for (const r of recs) {
  const yyyy = r.occurredAt.getUTCFullYear();
  const mm = String(r.occurredAt.getUTCMonth() + 1).padStart(2, "0");
  const vaultId = hex(16);
  const stem = `${yyyy}-${mm}-${String(r.occurredAt.getUTCDate()).padStart(2, "0")}_${vaultId.slice(0, 8)}`;
  const bytes = Math.round(r.durationSec * between(180_000, 420_000));
  const sha = hex(64);
  (r as Rec & { vaultId: string }).vaultId = vaultId;
  if (r.playableSample) {
    r.media.push({ storage: "local", bucket: null, key: `samples/sample-${r.playableSample}.webm`, role: "original", kind: "video", status: "verified", bytes: 0, mime: "video/webm", sha: `SAMPLE_SHA_${r.playableSample}` });
    continue;
  }
  if (r.source === "zoom") {
    r.media.push({ storage: "zoom", bucket: null, key: hex(22), role: "original", kind: "video", status: "verified", bytes, mime: "video/mp4", sha });
    r.media.push({ storage: "local", bucket: null, key: `${macRoot}/originals/${yyyy}/${stem}/zoom_0.mp4`, role: "original", kind: "video", status: rnd() < 0.3 ? "deleted_local" : "verified", bytes, mime: "video/mp4", sha });
    r.media.push({ storage: "local", bucket: null, key: `${macRoot}/originals/${yyyy}/${stem}/transcript.vtt`, role: "original", kind: "transcript_vtt", status: "verified", bytes: int(20_000, 90_000), mime: "text/vtt" });
    if (rnd() < 0.85) r.media.push({ storage: "b2", bucket: B2, key: `originals/${yyyy}/${mm}/${vaultId}/zoom_0.mp4`, role: "original", kind: "video", status: "verified", bytes, mime: "video/mp4", sha });
    if (rnd() < 0.35) r.media.push({ storage: "r2", bucket: R2, key: `proxies/${vaultId}.mp4`, role: "proxy", kind: "video", status: "verified", bytes: Math.round(bytes * 0.18), mime: "video/mp4" });
  } else if (r.source === "upload") {
    const name = /^IMG/.test(r.title) ? `${r.title}.MOV` : `${r.title.replace(/[^a-z0-9]+/gi, "_")}.mp4`;
    r.media.push({ storage: "r2", bucket: R2, key: `uploads/${yyyy}/${mm}/${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}/${name}`, role: "original", kind: "video", status: r.pipeline === "failed" ? "failed" : "verified", bytes, mime: name.endsWith(".MOV") ? "video/quicktime" : "video/mp4", sha });
    if (r.pipeline === null || r.pipeline === "ready") {
      if (rnd() < 0.5) r.media.push({ storage: "r2", bucket: R2, key: `proxies/${vaultId}.mp4`, role: "proxy", kind: "video", status: "verified", bytes: Math.round(bytes * 0.18), mime: "video/mp4" });
      if (rnd() < 0.5) r.media.push({ storage: "local", bucket: null, key: `${macRoot}/originals/${yyyy}/${stem}/${name}`, role: "original", kind: "video", status: "verified", bytes, mime: "video/mp4", sha });
    }
  } else {
    const name = `Call ${r.occurredAt.toISOString().slice(0, 10)}.m4a`;
    const abytes = Math.round(r.durationSec * 12_000);
    if (rnd() < 0.6) r.media.push({ storage: "r2", bucket: R2, key: `uploads/${yyyy}/${mm}/${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}/${name}`, role: "original", kind: "audio", status: "verified", bytes: abytes, mime: "audio/mp4", sha });
    else r.media.push({ storage: "local", bucket: null, key: `${macRoot}/originals/${yyyy}/${stem}/${name}`, role: "original", kind: "audio", status: "verified", bytes: abytes, mime: "audio/mp4", sha });
  }
}

// ----------------------------------------------------------- segments --
interface Seg { rec: number; idx: number; start: number; end: number; speaker: string; partyId: number | null; text: string }
const segs: Seg[] = [];
const TARGET_SEGMENTS = 4000;
const transcribable = recs.filter((r) => r.pipeline === null || r.pipeline === "ready");
const totalDur = transcribable.reduce((a, r) => a + r.durationSec, 0);
for (const r of transcribable) {
  const n = Math.max(12, Math.round((r.durationSec / totalDur) * TARGET_SEGMENTS));
  const pool = pools[r.ws ?? pick(Object.keys(pools))];
  let t = between(0.4, 3);
  const gap = (r.durationSec - t) / n;
  let speakerIdx = 0;
  for (let i = 0; i < n && t < r.durationSec - 1; i++) {
    if (rnd() < 0.45) speakerIdx = int(0, r.speakers.length - 1);
    const sp = r.speakers[speakerIdx];
    const text = rnd() < 0.55 ? pick(pool) : pick(general);
    const dur = Math.min(gap * between(0.5, 0.95), 2 + text.length / 14);
    segs.push({ rec: r.id, idx: i, start: round1(t), end: round1(t + dur), speaker: sp.label, partyId: sp.partyId, text });
    t += gap;
  }
  for (const sp of r.seedPhraseAt ?? []) {
    const s = r.speakers[sp.speakerIdx ?? 0];
    const mine = segs.filter((x) => x.rec === r.id).sort((a, b) => a.start - b.start);
    // Insert the phrase at the given time, nudging neighbours so timings stay monotonic.
    const dur = 4.5;
    for (const x of mine) if (x.start >= sp.at && x.start < sp.at + dur + 0.5) x.start = round1(sp.at + dur + 0.6 + (x.start - sp.at)), (x.end = round1(x.start + 2));
    segs.push({ rec: r.id, idx: -1, start: sp.at, end: sp.at + dur, speaker: s.label, partyId: s.partyId, text: sp.text });
  }
}
function round1(n: number) { return Math.round(n * 10) / 10; }
// renumber idx per recording by start time
for (const r of transcribable) {
  const mine = segs.filter((x) => x.rec === r.id).sort((a, b) => a.start - b.start || a.idx - b.idx);
  mine.forEach((x, i) => (x.idx = i));
}
segs.sort((a, b) => a.rec - b.rec || a.idx - b.idx);

// -------------------------------------------------------- facts etc. --
const factKinds = ["commitment", "decision", "price", "followup"] as const;
const facts: Array<{ rec: number; ws: string | null; kind: string; text: string; owner: number | null; about: number | null; amount: number | null; due: string | null; status: string; at: number; project: number | null }> = [];
for (const r of transcribable) {
  if (rnd() > 0.5) continue;
  const mine = segs.filter((x) => x.rec === r.id);
  const n = int(1, 3);
  for (let i = 0; i < n; i++) {
    const s = pick(mine);
    const kind = pick(factKinds);
    const other = r.participants.find((p) => p !== P["Ben Strout"]) ?? null;
    const amountMatch = /(\d[\d,]*) ?(thousand|dollars|percent)/i.exec(s.text);
    facts.push({
      rec: r.id, ws: r.ws, kind,
      text: kind === "price" && amountMatch ? s.text : kind === "commitment" ? `${nameOf(s.partyId ?? other ?? 1)} will: ${s.text}` : s.text,
      owner: s.partyId ?? other, about: other, amount: kind === "price" && amountMatch ? parseInt(amountMatch[1].replace(/,/g, ""), 10) * (/thousand/i.test(amountMatch[2]) ? 1000 : 1) : null,
      due: kind === "followup" || kind === "commitment" ? new Date(r.occurredAt.getTime() + int(3, 21) * 86400_000).toISOString().slice(0, 10) : null,
      status: rnd() < 0.7 ? "open" : "done", at: Math.floor(s.start), project: r.projectId ?? null,
    });
  }
}

const hooks = [
  "The one line item every client wants to cut first",
  "Why we never quote a firm price before the site visit",
  "Sunrise drone pass: the shot that sells the whole video",
  "What a seed term sheet actually says",
  "Cedar vs cypress: a twelve percent decision",
  "The permit office is the schedule",
  "Scope the pilot so it is easy to say yes",
  "Clerestory beats skylight in a Houston summer",
];
const clipCandidates: Array<{ rec: number; start: number; end: number; score: number; hook: string; why: string; status: string }> = [];
for (const r of transcribable) {
  if (rnd() > 0.35) continue;
  const mine = segs.filter((x) => x.rec === r.id);
  const s = pick(mine);
  clipCandidates.push({
    rec: r.id, start: Math.max(0, Math.floor(s.start) - 3), end: Math.min(r.durationSec, Math.floor(s.start) + 28), score: int(55, 94),
    hook: pick(hooks), why: `Self-contained point with a clear hook; ${s.speaker} states it plainly.`,
    status: pick(["new", "new", "new", "approved", "rejected"]),
  });
}
// Guarantee a 'new' clip candidate on a playable recording for the e2e approve test.
const sample2 = recs.find((r) => r.playableSample === 2)!;
clipCandidates.push({ rec: sample2.id, start: 38, end: 66, score: 88, hook: "Pelican tiles against stucco: the sample that settled it", why: "Visual payoff plus a clear decision in under thirty seconds.", status: "new" });

const review: Array<{ type: string; proposal: Record<string, unknown>; reason: string; rec: number }> = [];
for (const r of transcribable.filter((x) => x.source !== "zoom").slice(0, 5)) {
  const unknown = r.speakers.find((s) => s.partyId === null);
  const guess = r.participants.find((p) => p !== P["Ben Strout"]);
  if (!unknown || !guess) continue;
  const seg = segs.find((x) => x.rec === r.id && x.speaker === unknown.label);
  const conf = round2(between(0.62, 0.93));
  review.push({
    type: "participant_match",
    proposal: { interaction_id: r.id, speaker_label: unknown.label, party_id: guess, confidence: conf, start_sec: seg?.start ?? 0 },
    reason: `${unknown.label} is probably ${nameOf(guess)} (${conf.toFixed(2)})`,
    rec: r.id,
  });
}
function round2(n: number) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------- SQL --
const out: string[] = [];
out.push("-- Generated by scripts/gen-seed.ts. Do not edit by hand; re-run the generator.");
out.push("-- Realistic fake data for local development and tests. Never load into production.");
out.push("begin;");
out.push("set local timezone = 'UTC';");
out.push("");
out.push("insert into workspaces (id, name, owner, notes) values");
out.push(workspaces.map((w) => `  (${q(w.id)}, ${q(w.name)}, 'Ben Strout', ${q(w.notes)})`).join(",\n") + ";");
out.push("");
out.push("insert into parties (id, kind, name, emails, phones, location, website, notes) values");
out.push(parties.map((p) => `  (${p.id}, ${q(p.kind)}, ${q(p.name)}, ${q(p.emails ?? [])}, ${q(p.phones ?? [])}, ${q(p.location ?? null)}, ${q(p.website ?? null)}, ${q(p.notes ?? null)})`).join(",\n") + ";");
out.push("");
out.push("insert into roles (workspace_id, party_id, role, status, market, detail) values");
out.push(roles.map((r) => `  (${q(r.ws)}, ${r.party}, ${q(r.role)}, ${q(r.status)}, ${q(r.market)}, ${q(r.detail)})`).join(",\n") + ";");
out.push("");
out.push("insert into affiliations (person_id, org_id, title, is_current) values");
out.push(affiliations.map((a) => `  (${a.person}, ${a.org}, ${q(a.title)}, true)`).join(",\n") + ";");
out.push("");
out.push("insert into projects (id, workspace_id, name, address, status) values");
out.push(projects.map((p) => `  (${p.id}, ${q(p.ws)}, ${q(p.name)}, ${q(p.address)}, ${q(p.status)})`).join(",\n") + ";");
out.push("insert into project_parties (project_id, party_id, role) values");
out.push(projects.flatMap((p) => p.parties.map(([pid, role]) => `  (${p.id}, ${pid}, ${q(role)})`)).join(",\n") + ";");
out.push("");

out.push("insert into interactions (id, workspace_id, kind, occurred_at, title, summary, transcript, vault_id, source, original_filename, content_sha256, tags, duration_sec, host_email, participants_raw, pipeline_status, pipeline_error, pipeline_updated_at, created_at, updated_at) values");
out.push(
  recs
    .map((r) => {
      const mine = segs.filter((s) => s.rec === r.id);
      const transcript = mine.length ? mine.map((s) => `${s.speaker}: ${s.text}`).join("\n") : null;
      const kind = r.source === "zoom" ? "meeting" : r.source === "iphone_call" ? "call" : "other";
      const original = r.media.find((m) => m.role === "original");
      const filename = r.source === "zoom" ? null : original?.key.split("/").pop() ?? null;
      const participantsRaw = r.source === "zoom" ? r.participants.map((p) => ({ name: nameOf(p), email: parties.find((x) => x.id === p)?.emails?.[0] ?? null })) : null;
      return `  (${r.id}, ${q(r.ws)}, ${q(kind)}, ${q(r.occurredAt)}, ${q(r.title)}, ${q(r.summary)}, ${q(transcript)}, ${q((r as Rec & { vaultId: string }).vaultId)}, ${q(r.source)}, ${q(filename)}, ${q(original?.sha ?? null)}, ${q(r.tags)}, ${r.durationSec}, ${q(r.source === "zoom" ? "ben@example.com" : null)}, ${q(participantsRaw)}, ${q(r.pipeline)}, ${q(r.pipelineError ?? null)}, ${q(r.occurredAt)}, ${q(r.occurredAt)}, ${q(r.occurredAt)})`;
    })
    .join(",\n") + ";",
);
out.push("");

out.push("insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, kind, role, mime_type, bytes, sha256, status, recorded_at, original_filename, verified_at, created_at) values");
out.push(
  recs
    .flatMap((r) =>
      r.media.map(
        (m) =>
          `  (${r.id}, ${q(r.ws)}, ${q(r.source)}, ${q(m.storage)}, ${q(m.bucket)}, ${q(m.key)}, ${q(m.kind)}, ${q(m.role)}, ${q(m.mime)}, ${m.bytes || "null"}, ${q(m.sha ?? null)}, ${q(m.status)}, ${q(r.occurredAt)}, ${q(m.key.split("/").pop())}, ${m.status === "verified" ? q(r.occurredAt) : "null"}, ${q(r.occurredAt)})`,
      ),
    )
    .join(",\n") + ";",
);
out.push("update interactions i set media_id = (select min(m.id) from media m where m.interaction_id = i.id and m.role = 'original');");
out.push("");

// jobs for in-flight / failed uploads
out.push("insert into jobs (media_id, stage, status, attempts, error)");
out.push("select m.id, j.stage, j.status, j.attempts, j.error from media m");
out.push("join interactions i on i.id = m.interaction_id");
out.push("cross join lateral (values");
out.push("  ('transcribe', case i.pipeline_status when 'queued' then 'pending' when 'transcribing' then 'running' when 'failed' then 'failed' else 'done' end, case when i.pipeline_status = 'failed' then 3 else 1 end, case when i.pipeline_status = 'failed' then i.pipeline_error end),");
out.push("  ('extract', case i.pipeline_status when 'queued' then 'pending' when 'transcribing' then 'pending' when 'failed' then 'skipped' else 'done' end, 0, null)");
out.push(") as j(stage, status, attempts, error)");
out.push("where m.role = 'original' and m.storage in ('r2', 'local') and i.source in ('upload', 'iphone_call') and i.pipeline_status is not null;");
out.push("");

out.push("insert into transcripts (interaction_id, source, model, language, segment_count, word_count, has_words, duration_sec) values");
out.push(
  transcribable
    .map((r) => {
      const mine = segs.filter((s) => s.rec === r.id);
      const words = mine.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
      const src = r.source === "zoom" ? (rnd() < 0.5 ? "zoom_vtt" : "groq") : "groq";
      return `  (${r.id}, ${q(src)}, ${q(src === "groq" ? "whisper-large-v3-turbo" : null)}, 'en', ${mine.length}, ${words}, false, ${r.durationSec})`;
    })
    .join(",\n") + ";",
);
out.push("");

out.push("insert into interaction_participants (interaction_id, party_id, speaker_label, confidence) values");
out.push(
  recs
    .flatMap((r) =>
      r.participants.map((pid) => {
        const sp = r.speakers.find((s) => s.partyId === pid);
        return `  (${r.id}, ${pid}, ${q(sp?.label ?? null)}, ${sp ? (r.source === "zoom" ? 1 : 0.95) : "null"})`;
      }),
    )
    .join(",\n") + ";",
);
out.push("insert into interaction_links (interaction_id, project_id) values");
out.push(recs.filter((r) => r.projectId).map((r) => `  (${r.id}, ${r.projectId})`).join(",\n") + ";");
out.push("");

// segments in chunks
const CHUNK = 400;
for (let i = 0; i < segs.length; i += CHUNK) {
  out.push("insert into segments (interaction_id, idx, start_sec, end_sec, speaker, speaker_party_id, text) values");
  out.push(
    segs
      .slice(i, i + CHUNK)
      .map((s) => `  (${s.rec}, ${s.idx}, ${s.start}, ${s.end}, ${q(s.speaker)}, ${q(s.partyId)}, ${q(s.text)})`)
      .join(",\n") + ";",
  );
}
out.push("");

out.push("insert into facts (interaction_id, workspace_id, kind, text, owner_party_id, about_party_id, project_id, amount, due_date, status, confidence, quote_start_sec) values");
out.push(
  facts
    .map((f) => `  (${f.rec}, ${q(f.ws)}, ${q(f.kind)}, ${q(f.text)}, ${q(f.owner)}, ${q(f.about)}, ${q(f.project)}, ${q(f.amount)}, ${q(f.due)}, ${q(f.status)}, ${round2(between(0.6, 0.98))}, ${f.at})`)
    .join(",\n") + ";",
);
out.push("");
out.push("insert into clip_candidates (interaction_id, start_sec, end_sec, score, hook, why, platforms, status, model) values");
out.push(clipCandidates.map((c) => `  (${c.rec}, ${c.start}, ${c.end}, ${c.score}, ${q(c.hook)}, ${q(c.why)}, 'tiktok,reels', ${q(c.status)}, 'claude-sonnet')`).join(",\n") + ";");
out.push("");
out.push("insert into review_queue (item_type, proposal, reason, interaction_id, status) values");
out.push(review.map((r) => `  (${q(r.type)}, ${q(r.proposal)}, ${q(r.reason)}, ${r.rec}, 'open')`).join(",\n") + ";");
out.push("");
out.push("insert into relationships (from_party_id, to_party_id, kind, workspace_id, first_seen, last_seen, evidence_count) values");
out.push(
  [
    [P["Ben Strout"], P["Kevin McGuire"], "works_with", "another_story", 7],
    [P["Ben Strout"], P["Maria Delgado"], "client_of", "strout_arch", 5],
    [P["Carlos Mendes"], P["Maria Delgado"], "builds_for", "strout_arch", 3],
    [P["Lena Fischer"], P["Tom Ashworth"], "supplies", "southern_shutter", 2],
  ]
    .map(([a, b, kind, ws, n]) => `  (${a}, ${b}, ${q(kind)}, ${q(ws)}, '2024-01-15T00:00:00Z', '2026-09-01T00:00:00Z', ${n})`)
    .join(",\n") + ";",
);
out.push("");
out.push("select setval('parties_id_seq', (select max(id) from parties));");
out.push("select setval('projects_id_seq', (select max(id) from projects));");
out.push("select setval('interactions_id_seq', (select max(id) from interactions));");
out.push("commit;");

fs.writeFileSync(OUT, out.join("\n") + "\n");
const sizeKb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote ${OUT}: ${recs.length} recordings, ${segs.length} segments, ${recs.reduce((a, r) => a + r.media.length, 0)} media rows, ${facts.length} facts, ${clipCandidates.length} clip candidates, ${review.length} review items (${sizeKb} KB)`);
