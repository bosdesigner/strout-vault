// Pure classifier: turns the signals gathered for one recording into a workspace proposal
// with a confidence and the evidence behind it, or null when the signals are missing or
// disagree. No database access here, so the rules are unit-testable.
import { ACCOUNT_DEFAULT_TITLES, WORKSPACE_RULES, type WorkspaceRule } from "./rules.ts";

export interface RecordingSignals {
  interactionId: number;
  title: string | null;
  /** Transcript keyword hits per workspace id (segments matching any of that workspace's transcript patterns). */
  transcriptHits: Record<string, number>;
  /** Known people whose name appears in the title, with the single workspace each belongs to. */
  peopleInTitle: Array<{ name: string; workspaceId: string; strong: boolean }>;
  /** Total segments, so keyword counts can be read as a share. */
  segmentCount: number;
}

export interface WorkspaceProposal {
  interactionId: number;
  workspaceId: string;
  /** 0.5-0.95. Title rule or a strong name 0.85+, keyword majority 0.6-0.75. */
  confidence: number;
  evidence: string[];
  /** Workspaces that also had some signal, for the reviewer. */
  alsoConsidered: string[];
}

export interface ClassifyOptions {
  rules?: WorkspaceRule[];
  /** Transcript hits needed before keywords count at all. Default 3. */
  minTranscriptHits?: number;
  /** The leading workspace needs at least this many times the runner-up's hits. Default 3. */
  majority?: number;
}

export function isAccountDefaultTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return !t || ACCOUNT_DEFAULT_TITLES.some((re) => re.test(t));
}

export function classifyRecording(s: RecordingSignals, opts: ClassifyOptions = {}): WorkspaceProposal | null {
  const rules = opts.rules ?? WORKSPACE_RULES;
  const minHits = opts.minTranscriptHits ?? 3;
  const majority = opts.majority ?? 3;
  const votes = new Map<string, { score: number; evidence: string[] }>();
  const vote = (ws: string, score: number, why: string) => {
    const v = votes.get(ws) ?? { score: 0, evidence: [] };
    v.score = Math.max(v.score, score);
    v.evidence.push(why);
    votes.set(ws, v);
  };

  // 1. Title patterns.
  const title = (s.title ?? "").trim();
  if (!isAccountDefaultTitle(title)) {
    for (const rule of rules) {
      const hit = rule.title.find((re) => re.test(title));
      if (hit) vote(rule.workspaceId, 0.9, `title matches ${hit.source}`);
    }
    // 2. Known people named in the title.
    for (const p of s.peopleInTitle) vote(p.workspaceId, p.strong ? 0.85 : 0.6, `title names ${p.name} (${p.workspaceId})`);
  }

  // 3. Transcript keyword majority.
  const hits = Object.entries(s.transcriptHits).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (hits.length && hits[0][1] >= minHits) {
    const [leader, n] = hits[0];
    const runnerUp = hits[1]?.[1] ?? 0;
    if (runnerUp === 0 || n >= runnerUp * majority) {
      const share = s.segmentCount ? n / s.segmentCount : 0;
      const confidence = n >= 10 && share >= 0.02 ? 0.75 : n >= 5 ? 0.7 : 0.6;
      vote(leader, confidence, `${n} transcript line(s) mention ${leader} terms${runnerUp ? ` (runner-up ${hits[1][0]}: ${runnerUp})` : ""}`);
    }
  }

  if (!votes.size) return null;
  const ranked = [...votes.entries()].sort((a, b) => b[1].score - a[1].score || b[1].evidence.length - a[1].evidence.length);
  const [best, bestVote] = ranked[0];
  const second = ranked[1];
  // Two strong, disagreeing signals: leave it to a human.
  if (second && second[1].score >= 0.85 && bestVote.score >= 0.85) return null;
  let confidence = bestVote.score;
  if (bestVote.evidence.length > 1) confidence = Math.min(0.95, confidence + 0.05);
  if (second && second[1].score >= 0.6) confidence = Math.max(0.5, confidence - 0.1);
  return {
    interactionId: s.interactionId,
    workspaceId: best,
    confidence: Number(confidence.toFixed(2)),
    evidence: bestVote.evidence,
    alsoConsidered: ranked.slice(1).map(([ws, v]) => `${ws} (${v.evidence.join("; ")})`),
  };
}
