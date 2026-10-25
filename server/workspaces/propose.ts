// Gathers signals for every recording without a workspace, classifies them, and (on apply)
// queues one review_queue row per recording for the owner to approve. Approval is what
// writes interactions.workspace_id (services/review.ts); this module never does.
import type pg from "pg";
import { classifyRecording, type ClassifyOptions, type RecordingSignals, type WorkspaceProposal } from "./classify.ts";
import { WORKSPACE_RULES } from "./rules.ts";

export const WORKSPACE_ITEM_TYPE = "interaction_workspace";

export interface ProposeOptions extends ClassifyOptions {
  minConfidence?: number;
  limit?: number;
  /** Only propose this workspace (useful for a first small pass). */
  onlyWorkspace?: string;
}

export interface ProposeReport {
  candidates: number;
  proposed: WorkspaceProposal[];
  undecided: Array<{ interactionId: number; title: string | null; reason: string }>;
  byWorkspace: Record<string, number>;
  byConfidence: { high: number; medium: number; low: number };
  skippedOpenProposal: number;
}

interface KnownPerson {
  name: string;
  workspaceId: string;
  strong: boolean;
}

/** People with roles in exactly one workspace; a multi-word name is a strong signal, a single word a weak one. */
async function knownPeople(pool: pg.Pool): Promise<KnownPerson[]> {
  const { rows } = await pool.query(
    `select p.name, min(r.workspace_id) as workspace_id from parties p join roles r on r.party_id = p.id
      where p.kind = 'person' group by p.id having count(distinct r.workspace_id) = 1`,
  );
  return rows
    .map((r) => ({ name: String(r.name).trim(), workspaceId: r.workspace_id as string }))
    .filter((p) => p.name.length >= 3)
    .map((p) => ({ ...p, strong: p.name.split(/\s+/).length >= 2 }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** JS regex source → Postgres advanced regex: \b (word boundary) becomes \y; the rest we use is shared. */
export const toPgRegex = (re: RegExp) => re.source.replace(/\\b/g, "\\y");

/** Signals for every recording without a workspace: title, keyword counts (one query over segments), people in the title. */
export async function collectSignals(pool: pg.Pool, opts: { limit?: number } = {}): Promise<{ signals: RecordingSignals[]; openProposals: Set<number> }> {
  const rules = WORKSPACE_RULES;
  // One parameter per transcript pattern, translated from JS regex syntax to Postgres ARE
  // (word boundaries are \y there, not \b). Counted with ~* so case never matters.
  const flatParams: string[] = [];
  const counts = rules.map(
    (r, i) =>
      `count(*) filter (where ${r.transcript
        .map((re) => {
          flatParams.push(toPgRegex(re));
          return `s.text ~* $${flatParams.length}`;
        })
        .join(" or ")})::int as ws_${i}`,
  );
  const { rows } = await pool.query(
    `select i.id, i.title, (select count(*)::int from segments s where s.interaction_id = i.id) as segment_count,
            ${rules.map((_, i) => `coalesce(h.ws_${i}, 0) as ws_${i}`).join(", ")}
       from interactions i
       left join lateral (select ${counts.join(", ")} from segments s where s.interaction_id = i.id) h on true
      where i.workspace_id is null
      order by i.occurred_at desc nulls last, i.id desc ${opts.limit ? `limit ${Math.max(1, Math.floor(opts.limit))}` : ""}`,
    flatParams,
  );
  const people = await knownPeople(pool);
  const open = await pool.query(`select interaction_id from review_queue where item_type = $1 and status = 'open' and interaction_id is not null`, [WORKSPACE_ITEM_TYPE]);
  const openProposals = new Set<number>(open.rows.map((r) => Number(r.interaction_id)));
  const signals: RecordingSignals[] = rows.map((r) => {
    const title = (r.title as string | null) ?? "";
    const transcriptHits: Record<string, number> = {};
    rules.forEach((rule, i) => (transcriptHits[rule.workspaceId] = Number(r[`ws_${i}`] ?? 0)));
    const peopleInTitle = people.filter((p) => new RegExp(`\\b${escapeRe(p.name)}\\b`, "i").test(title));
    return { interactionId: Number(r.id), title: r.title, transcriptHits, peopleInTitle, segmentCount: Number(r.segment_count ?? 0) };
  });
  return { signals, openProposals };
}

export async function proposeWorkspaces(pool: pg.Pool, opts: ProposeOptions = {}): Promise<ProposeReport> {
  const minConfidence = opts.minConfidence ?? 0.6;
  const { signals, openProposals } = await collectSignals(pool, { limit: opts.limit });
  const report: ProposeReport = { candidates: signals.length, proposed: [], undecided: [], byWorkspace: {}, byConfidence: { high: 0, medium: 0, low: 0 }, skippedOpenProposal: 0 };
  for (const s of signals) {
    if (openProposals.has(s.interactionId)) {
      report.skippedOpenProposal++;
      continue;
    }
    const p = classifyRecording(s, opts);
    if (!p) {
      report.undecided.push({ interactionId: s.interactionId, title: s.title, reason: Object.values(s.transcriptHits).some((n) => n > 0) || s.peopleInTitle.length ? "signals disagree or are too weak" : "no signal" });
      continue;
    }
    if (p.confidence < minConfidence) {
      report.undecided.push({ interactionId: s.interactionId, title: s.title, reason: `confidence ${p.confidence} below ${minConfidence} (${p.workspaceId}: ${p.evidence.join("; ")})` });
      continue;
    }
    if (opts.onlyWorkspace && p.workspaceId !== opts.onlyWorkspace) continue;
    report.proposed.push(p);
    report.byWorkspace[p.workspaceId] = (report.byWorkspace[p.workspaceId] ?? 0) + 1;
    if (p.confidence >= 0.85) report.byConfidence.high++;
    else if (p.confidence >= 0.7) report.byConfidence.medium++;
    else report.byConfidence.low++;
  }
  return report;
}

/** Queues the proposals as review items (status open). Returns the review ids. */
export async function queueProposals(pool: pg.Pool, proposals: WorkspaceProposal[], proposedBy: string): Promise<number[]> {
  const ids: number[] = [];
  const titles = new Map<number, string | null>();
  if (proposals.length) {
    const { rows } = await pool.query(`select id, title from interactions where id = any($1::bigint[])`, [proposals.map((p) => p.interactionId)]);
    for (const r of rows) titles.set(Number(r.id), r.title);
  }
  for (const p of proposals) {
    const proposal = { interaction_id: p.interactionId, workspace_id: p.workspaceId, confidence: p.confidence, evidence: p.evidence, also_considered: p.alsoConsidered, source: "workspace-proposer", proposed_by: proposedBy, proposed_at: new Date().toISOString() };
    const reason = `File "${titles.get(p.interactionId) ?? `#${p.interactionId}`}" under ${p.workspaceId} (${Math.round(p.confidence * 100)}%): ${p.evidence.join("; ")}`;
    const { rows } = await pool.query(
      `insert into review_queue (item_type, proposal, reason, interaction_id, status) values ($1, $2::jsonb, $3, $4, 'open') returning id`,
      [WORKSPACE_ITEM_TYPE, JSON.stringify(proposal), reason.slice(0, 1000), p.interactionId],
    );
    ids.push(Number(rows[0].id));
  }
  return ids;
}
