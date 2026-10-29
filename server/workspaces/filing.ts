// Title rules that file a recording under a workspace on their own (config/filing_rules.yml).
// Unlike the classifier (classify.ts, which proposes for review), a matching rule writes
// interactions.workspace_id directly and records which rule did it in interactions.filed_by,
// so a bad rule can be reverted as a set:
//   update interactions set workspace_id = null, filed_by = null where filed_by = 'rule:<n>';
// Guardrails no rule can override: a filed recording is never moved, phalanx is never assigned
// automatically, and a filing Ben rejected on Review is never made again.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type pg from "pg";
import { NEVER_AUTO_ASSIGNED } from "../messages/ingest.ts";

export interface FilingRule {
  /** 1-based position in the file; filed_by records it as "rule:<index>". */
  index: number;
  workspaceId: string;
  titles: RegExp[];
  sources: string[] | null;
  note: string | null;
}

export const FILING_RULES_FILE = "filing_rules.yml";
const WS_ID = /^[a-z0-9_-]{1,100}$/;
/** Review item types that carry a workspace decision for one interaction. */
export const WORKSPACE_DECISION_TYPES = ["interaction_workspace", "workspace_assignment"];

export function parseFilingRules(doc: unknown): FilingRule[] {
  if (doc == null) return [];
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${FILING_RULES_FILE} must be a mapping with a "rules" list`);
  const list = (doc as { rules?: unknown }).rules ?? [];
  if (!Array.isArray(list)) throw new Error(`${FILING_RULES_FILE}: "rules" must be a list`);
  return list.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const where = `${FILING_RULES_FILE}: rule ${i + 1}`;
    if (typeof r.workspace !== "string" || !WS_ID.test(r.workspace)) throw new Error(`${where}: "workspace" must be a workspace id`);
    if (!Array.isArray(r.titles) || !r.titles.length) throw new Error(`${where}: "titles" must be a non-empty list of patterns`);
    const titles = r.titles.map((t) => {
      if (typeof t !== "string" || !t.trim()) throw new Error(`${where}: every title pattern must be a string`);
      try {
        return new RegExp(t, "i");
      } catch (err) {
        throw new Error(`${where}: bad pattern ${JSON.stringify(t)}: ${(err as Error).message}`);
      }
    });
    const sources = r.sources == null ? null : Array.isArray(r.sources) ? r.sources.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : null;
    return { index: i + 1, workspaceId: r.workspace, titles, sources, note: typeof r.note === "string" ? r.note : null };
  });
}

export function loadFilingRules(configDir: string): FilingRule[] {
  const file = path.join(configDir, FILING_RULES_FILE);
  if (!fs.existsSync(file)) return [];
  return parseFilingRules(parse(fs.readFileSync(file, "utf8")));
}

/** Collapses the stray spaces Zoom titles carry ("Allan Lajeunesse : AnotherStory Assessment"). */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([:,;])/g, "$1")
    .trim();
}

export interface RuleMatch {
  rule: FilingRule;
  pattern: string;
}

/** The first rule whose title pattern matches (and whose sources include this one, if it lists any). */
export function matchFilingRule(title: string | null | undefined, source: string | null | undefined, rules: FilingRule[]): RuleMatch | null {
  const t = normalizeTitle(title);
  if (!t) return null;
  for (const rule of rules) {
    if (rule.sources && !rule.sources.includes(String(source ?? "").toLowerCase())) continue;
    const hit = rule.titles.find((re) => re.test(t));
    if (hit) return { rule, pattern: hit.source };
  }
  return null;
}

export interface FilingOutcome {
  workspaceId: string | null;
  filedBy: string | null;
  /** Why nothing was filed, when a rule matched but a guardrail stopped it. */
  blocked?: string;
}

/** Workspaces Ben rejected for this interaction on Review (either decision type). */
export async function rejectedWorkspaces(db: pg.Pool | pg.PoolClient, interactionId: number): Promise<Set<string>> {
  const { rows } = await db.query(
    `select distinct proposal->>'workspace_id' as ws from review_queue
      where interaction_id = $1 and item_type = any($2::text[]) and status = 'rejected' and proposal->>'workspace_id' is not null`,
    [interactionId, WORKSPACE_DECISION_TYPES],
  );
  return new Set(rows.map((r) => r.ws as string));
}

/**
 * Files one interaction under `workspaceId` if it is still unfiled and no guardrail objects.
 * Moves its media along and closes open workspace review items that agree. Returns true when filed.
 */
export async function fileInteraction(db: pg.Pool | pg.PoolClient, interactionId: number, workspaceId: string, filedBy: string): Promise<{ filed: boolean; blocked?: string }> {
  if (NEVER_AUTO_ASSIGNED.includes(workspaceId)) return { filed: false, blocked: `${workspaceId} is never assigned automatically` };
  const known = await db.query(`select 1 from workspaces where id = $1`, [workspaceId]);
  if (!known.rowCount) return { filed: false, blocked: `workspace ${workspaceId} does not exist` };
  if ((await rejectedWorkspaces(db, interactionId)).has(workspaceId)) return { filed: false, blocked: `filing under ${workspaceId} was rejected on Review` };
  const moved = await db.query(`update interactions set workspace_id = $2, filed_by = $3, updated_at = now() where id = $1 and workspace_id is null`, [interactionId, workspaceId, filedBy]);
  if (!moved.rowCount) return { filed: false, blocked: "already filed" };
  await db.query(`update media set workspace_id = $2 where interaction_id = $1 and workspace_id is null`, [interactionId, workspaceId]);
  await db.query(
    `update review_queue set status = 'approved', decided_at = now()
      where interaction_id = $1 and item_type = any($2::text[]) and status = 'open' and proposal->>'workspace_id' = $3`,
    [interactionId, WORKSPACE_DECISION_TYPES, workspaceId],
  );
  return { filed: true };
}

/** Applies the title rules to one unfiled interaction. */
export async function applyFilingRules(db: pg.Pool | pg.PoolClient, rules: FilingRule[], row: { id: number; title: string | null; source: string | null }): Promise<FilingOutcome> {
  const m = matchFilingRule(row.title, row.source, rules);
  if (!m) return { workspaceId: null, filedBy: null };
  const filedBy = `rule:${m.rule.index}`;
  const r = await fileInteraction(db, row.id, m.rule.workspaceId, filedBy);
  return r.filed ? { workspaceId: m.rule.workspaceId, filedBy } : { workspaceId: null, filedBy: null, blocked: r.blocked };
}
