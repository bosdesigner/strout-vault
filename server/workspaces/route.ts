// The content classifier (Phase 1 v2): one decision per interaction, from what it contains rather
// than what it is called. Pure, no database or network: server/workspaces/classifyStep.ts gathers the
// signals (participants' workspaces, the Gmail account, phalanx terms over the whole text, a Claude
// read of the first ~2,000 characters) and applies the decision.
//
// Order of precedence:
//   1. Phalanx guard. Phalanx, Shingle X, Dermatryx, Dermal X, Millpond, wound care, or investor /
//      cap-table material anywhere in the title or text means phalanx, whatever else points
//      elsewhere. Filed to phalanx at 0.8 or more; below that the item stays in inbox with a review
//      item suggesting phalanx. A phalanx-flagged item is never filed anywhere else.
//   2. The Gmail account: ben@anotherstory.com -> another_story, ben@stroutarch.com -> strout_arch.
//      stroubo@gmail.com carries no default and is classified from content.
//   3. Feasibility-study recordings (discovery, onboarding, delivery) -> another_story.
//   4. Participants: when every matched person maps to the same single workspace.
//   5. Claude's read, at CLASSIFY_MIN_CONFIDENCE (0.8) or more.
// Participants and Claude disagreeing, or nothing confident, leaves the item in inbox (with a review
// item when there is a suggestion worth looking at).

export const FILE_WORKSPACES = ["another_story", "strout_arch", "phalanx", "southern_shutter", "sepp", "credvault", "personal"] as const;
export type FileWorkspace = (typeof FILE_WORKSPACES)[number];
export const INBOX_WS = "inbox";

/** Strong phalanx terms: one in a title, or two lines of text, files to phalanx on its own. */
export const PHALANX_STRONG: RegExp[] = [/\bphalanx/i, /\bshingle[\s-]?x\b/i, /\bdermatryx\b/i, /\bdermal[\s-]?x\b/i, /\bmill\s?pond\b/i];
/** Weaker terms: investor and cap-table material, wound care. Phalanx only when Claude agrees; never filed elsewhere. */
export const PHALANX_WEAK: RegExp[] = [
  /\bwound[\s-]care\b/i,
  /\bcap(italization)?[\s-]table\b/i,
  /\bterm[\s-]sheet\b/i,
  /\b(pre|post)[\s-]money\b/i,
  /\bconvertible note\b/i,
  /\bSAFE (note|agreement)\b/,
  /\binvestor (deck|update|meeting|call|relations)\b/i,
  /\bpitch deck\b/i,
  /\b(seed|series [ab]) round\b/i,
  /\bphalanx nano\b/i,
];

/** Gmail account -> workspace. stroubo@gmail.com is deliberately absent: it is classified from content. */
export const ACCOUNT_WORKSPACES: Record<string, FileWorkspace> = {
  "ben@anotherstory.com": "another_story",
  "ben@stroutarch.com": "strout_arch",
};

export const FEASIBILITY = /\bfeasibility\b/i;

/** Postgres ARE versions of the phalanx patterns, for the full-text scan. */
export function phalanxPgPatterns(): { strong: string; weak: string } {
  const pg = (rs: RegExp[]) => rs.map((r) => r.source.replace(/\\b/g, "\\y")).join("|");
  return { strong: pg(PHALANX_STRONG), weak: pg(PHALANX_WEAK) };
}

export function phalanxTerms(text: string): { strong: string[]; weak: string[] } {
  const found = (rs: RegExp[]) => rs.flatMap((r) => (r.test(text) ? [String(text.match(r)?.[0] ?? r.source).toLowerCase()] : []));
  return { strong: found(PHALANX_STRONG), weak: found(PHALANX_WEAK) };
}

export interface LlmVerdict {
  workspace: string;
  confidence: number;
  reason: string;
  /** Claude saw Phalanx / investor material, whichever workspace it chose. */
  phalanx_material: boolean;
}

export interface ClassifySignals {
  interactionId: number;
  kind: string;
  title: string | null;
  /** interactions.workspace_id now (null, inbox, or a workspace the ingest already chose). */
  current: string | null;
  /** The Gmail mailbox the thread came from (source_payload.account). */
  account: string | null;
  /** Workspaces each matched participant maps to (roles, org affiliations, projects, routing rules). Ben is left out. */
  participants: Array<{ partyId: number; name: string; workspaces: string[] }>;
  /** Phalanx terms in the title. */
  titlePhalanx: { strong: string[]; weak: string[] };
  /** Lines of text matching a strong / weak phalanx term, over the whole interaction. */
  phalanxLines: { strong: number; weak: number };
  /** Claude's read, or null when the model was not asked (no budget, no text). */
  llm: LlmVerdict | null;
  /** True when the item was filed by a person (an approved workspace review item): only the phalanx guard may move it. */
  humanFiled?: boolean;
}

export interface ClassifyDecision {
  interactionId: number;
  /** Where the item goes: a workspace, or inbox. */
  workspaceId: string;
  confidence: number;
  evidence: string[];
  /** Did the decision move the item? false = it stays where it was. */
  changed: boolean;
  /** Set when the item stays in (or goes to) inbox but something deserves a look on Review. */
  review: { suggested: string; reason: string } | null;
  /** True when the phalanx guard decided. */
  phalanx: boolean;
}

export interface DecideOptions {
  minConfidence?: number;
  known?: ReadonlySet<string>;
}

const isFileWs = (ws: string | null | undefined, known?: ReadonlySet<string>): ws is FileWorkspace =>
  !!ws && (FILE_WORKSPACES as readonly string[]).includes(ws) && (!known || known.has(ws));

export function decideWorkspace(s: ClassifySignals, opts: DecideOptions = {}): ClassifyDecision {
  const min = opts.minConfidence ?? 0.8;
  const filed = !!s.current && s.current !== INBOX_WS;
  const keep = (why: string[]): ClassifyDecision => ({ interactionId: s.interactionId, workspaceId: s.current ?? INBOX_WS, confidence: 0, evidence: why, changed: false, review: null, phalanx: false });
  const to = (ws: string, confidence: number, evidence: string[], review: ClassifyDecision["review"] = null, phalanx = false): ClassifyDecision => ({
    interactionId: s.interactionId,
    workspaceId: ws,
    confidence: Number(Math.min(0.99, confidence).toFixed(2)),
    evidence,
    changed: ws !== (s.current ?? null),
    review,
    phalanx,
  });

  // 1. Phalanx guard.
  const strongHits = s.titlePhalanx.strong.length > 0 || s.phalanxLines.strong > 0;
  const weakHits = s.titlePhalanx.weak.length > 0 || s.phalanxLines.weak > 0;
  const llmPhalanx = s.llm && (s.llm.workspace === "phalanx" || s.llm.phalanx_material);
  // People who only exist in phalanx (investors, its partners) make the conversation phalanx too.
  const mapped = s.participants.filter((p) => p.workspaces.length);
  const phalanxPeople = mapped.length > 0 && mapped.every((p) => p.workspaces.length === 1 && p.workspaces[0] === "phalanx");
  if (s.current === "phalanx") return keep(["already phalanx"]);
  // An item already filed elsewhere is not moved on investor / wound-care vocabulary alone: those
  // words are common enough ("the investor on this flip") that Claude must confirm it first.
  const filedElsewhere = (!!s.current && s.current !== INBOX_WS) || !!s.humanFiled;
  if (filedElsewhere && weakHits && !strongHits && !llmPhalanx && !phalanxPeople) return keep(["investor / wound-care terms; waiting for Claude to confirm before moving"]);
  if (strongHits || weakHits || llmPhalanx || phalanxPeople) {
    const ev: string[] = [];
    let conf = 0.5;
    if (phalanxPeople) {
      conf = 0.85;
      ev.push(`participants are phalanx contacts (${mapped.map((p) => p.name).slice(0, 3).join(", ")})`);
    }
    if (s.titlePhalanx.strong.length) {
      conf = 0.95;
      ev.push(`title names ${s.titlePhalanx.strong.join(", ")}`);
    }
    if (s.phalanxLines.strong >= 2) {
      conf = Math.max(conf, s.phalanxLines.strong >= 5 ? 0.95 : 0.9);
      ev.push(`${s.phalanxLines.strong} line(s) mention phalanx terms`);
    } else if (s.phalanxLines.strong === 1) {
      conf = Math.max(conf, 0.6);
      ev.push("one passing mention of a phalanx term");
    }
    if (s.titlePhalanx.weak.length || s.phalanxLines.weak) {
      conf = Math.max(conf, 0.5);
      ev.push(`investor / wound-care terms: ${[...s.titlePhalanx.weak].join(", ") || `${s.phalanxLines.weak} line(s)`}`);
    }
    if (s.llm?.workspace === "phalanx") {
      conf = Math.max(conf, s.llm.confidence, strongHits ? Math.min(0.95, s.llm.confidence + 0.05) : 0);
      ev.push(`Claude: phalanx (${Math.round(s.llm.confidence * 100)}%): ${s.llm.reason}`);
    } else if (s.llm?.phalanx_material) {
      conf = Math.max(conf, 0.6);
      ev.push(`Claude saw phalanx material, filed it as ${s.llm.workspace}: ${s.llm.reason}`);
    } else if (s.llm && conf < min) {
      ev.push(`Claude: ${s.llm.workspace} (${Math.round(s.llm.confidence * 100)}%): ${s.llm.reason}`);
    }
    if (conf >= min && (!opts.known || opts.known.has("phalanx"))) return to("phalanx", conf, ev, null, true);
    // Borderline: never filed anywhere but phalanx. Out of a readable workspace, into inbox, for Ben.
    return to(INBOX_WS, conf, ev, { suggested: "phalanx", reason: `Possible Phalanx material (${Math.round(conf * 100)}%): ${ev.join("; ")}` }, true);
  }

  // Anything already filed (by the ingest's routing or by a person) is left where it is.
  if (filed || s.humanFiled) return keep(["already filed"]);

  // 2. Gmail account.
  const acct = s.account?.toLowerCase().trim() ?? "";
  const acctWs = ACCOUNT_WORKSPACES[acct];
  if (acctWs && isFileWs(acctWs, opts.known)) return to(acctWs, 0.9, [`email from the ${acct} mailbox`]);

  // 3. Feasibility studies are AnotherStory's.
  const recordingKinds = ["meeting", "call", "recording", "other"];
  if (recordingKinds.includes(s.kind) && FEASIBILITY.test(s.title ?? "") && isFileWs("another_story", opts.known)) {
    return to("another_story", 0.9, ["feasibility-study recording (title)"]);
  }

  // 4. Participants.
  const pWs = new Set<string>();
  for (const p of s.participants) for (const w of p.workspaces) if (isFileWs(w, opts.known) && w !== "phalanx") pWs.add(w);
  const people = s.participants.filter((p) => p.workspaces.length);
  const partVote = pWs.size === 1 && people.length ? { ws: [...pWs][0], conf: people.length >= 2 ? 0.9 : 0.85, ev: `${people.map((p) => p.name).slice(0, 3).join(", ")} → ${[...pWs][0]}` } : null;

  // 5. Claude.
  const llm = s.llm && isFileWs(s.llm.workspace, opts.known) ? s.llm : null;
  const feasLlm = llm && llm.workspace === "strout_arch" && /feasibility/i.test(llm.reason) && recordingKinds.includes(s.kind);
  const llmWs = feasLlm ? "another_story" : llm?.workspace;
  const llmEv = llm ? `Claude: ${llm.workspace}${feasLlm ? " (feasibility study → another_story)" : ""} (${Math.round(llm.confidence * 100)}%): ${llm.reason}` : null;

  if (partVote && llm) {
    if (partVote.ws === llmWs) return to(partVote.ws, Math.max(partVote.conf, llm.confidence) + 0.05, [`participants ${partVote.ev}`, llmEv!]);
    if (llm.confidence >= 0.9 && partVote.conf < 0.9) {
      return to(INBOX_WS, llm.confidence, [`participants ${partVote.ev}`, llmEv!], { suggested: llmWs!, reason: `Participants say ${partVote.ws}, content says ${llmWs}: ${llm.reason}` });
    }
    return to(partVote.ws, partVote.conf - 0.05, [`participants ${partVote.ev}`, `${llmEv} (overruled)`]);
  }
  if (partVote) return to(partVote.ws, partVote.conf, [`participants ${partVote.ev}`]);
  if (llm && llmWs) {
    if (llm.confidence >= min) return to(llmWs, llm.confidence, [llmEv!]);
    const ev = [llmEv!];
    if (pWs.size > 1) ev.push(`participants span ${[...pWs].join(", ")}`);
    return to(INBOX_WS, llm.confidence, ev, llm.confidence >= 0.5 ? { suggested: llmWs, reason: `Probably ${llmWs} (${Math.round(llm.confidence * 100)}%): ${llm.reason}` } : null);
  }
  return to(INBOX_WS, 0, [pWs.size > 1 ? `participants span ${[...pWs].join(", ")}` : "no signal"]);
}
