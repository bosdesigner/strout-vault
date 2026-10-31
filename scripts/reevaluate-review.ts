// Runs the auto-apply rules (docs/AUTO-APPLY.md) over every OPEN review item.
//
//   Dry run (default, read-only):
//     DATABASE_URL=… npx tsx scripts/reevaluate-review.ts --out docs/auto-apply-verification/dry-run.json
//   prints "would auto-apply" and "would stay queued", each item with its rule and source, and
//   writes the same lists as JSON (and a .md next to it) for Ben to read.
//
//   Apply (only after Ben has approved the dry run):
//     DATABASE_URL=… npx tsx scripts/reevaluate-review.ts --apply --approved docs/auto-apply-verification/dry-run.json
//   applies exactly the dry run's "would auto-apply" ids that still pass the rules (re-checked one by one
//   in its own transaction), leaves everything else queued, and prints before/after open counts and
//   every change it made. Each one is logged in auto_applies with an Undo, like any other auto-apply.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { evaluateProposal, routeReviewItemTx, DEFAULT_MIN_CONFIDENCE, type RouteDecision } from "../server/services/autoApply.ts";

dotenv.config();

export interface DryRunRow {
  review_id: number;
  item_type: string;
  rule: string;
  reasons: string[];
  confidence: number | null;
  interaction_id: number | null;
  interaction_title: string | null;
  quote: string | null;
  summary: string;
}

export interface DryRun {
  generated_at: string;
  database: string;
  open_before: number;
  min_confidence: number;
  would_auto_apply: DryRunRow[];
  would_stay_queued: DryRunRow[];
}

function summarize(type: string, p: Record<string, unknown>): string {
  if (type === "new_party") return `new ${String(p.kind ?? "party")}: ${String(p.name)}${(p.phones as string[] | undefined)?.length ? ` · ${(p.phones as string[]).join(", ")}` : ""}${(p.emails as string[] | undefined)?.length ? ` · ${(p.emails as string[]).join(", ")}` : ""}`;
  if (type === "party_edit") return `edit party #${String(p.party_id)}: ${JSON.stringify(p.changes)}`;
  if (type === "new_fact") return `${String(p.kind)}: ${String(p.text)}${typeof p.amount === "number" ? ` ($${p.amount})` : ""}`;
  if (type === "link_party_interaction" || type === "participant_match") return `tag party #${String(p.party_id)}${p.speaker_label ? ` as ${String(p.speaker_label)}` : ""}`;
  if (type === "link_project_interaction") return `link project #${String(p.project_id)}`;
  if (type === "new_relationship") return `#${String(p.from_party_id)} ${String(p.kind)} #${String(p.to_party_id)}`;
  if (type === "interaction_workspace" || type === "workspace_assignment") return `file under ${String(p.workspace_id ?? "?")}`;
  return type.replace(/_/g, " ");
}

export async function dryRun(pool: pg.Pool, minConfidence = DEFAULT_MIN_CONFIDENCE): Promise<DryRun> {
  const { rows } = await pool.query(
    `select rq.id, rq.item_type, rq.proposal, rq.reason, rq.interaction_id, i.title
       from review_queue rq left join interactions i on i.id = rq.interaction_id
      where rq.status = 'open' order by rq.id`,
  );
  const out: DryRun = { generated_at: new Date().toISOString(), database: dbLabel(), open_before: rows.length, min_confidence: minConfidence, would_auto_apply: [], would_stay_queued: [] };
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    for (const r of rows) {
      const d: RouteDecision = await evaluateProposal(client, { itemType: r.item_type, proposal: r.proposal ?? {}, reason: r.reason, interactionId: r.interaction_id == null ? null : Number(r.interaction_id) }, { minConfidence });
      const row: DryRunRow = {
        review_id: Number(r.id),
        item_type: r.item_type,
        rule: d.rule,
        reasons: d.reasons,
        confidence: d.confidence,
        interaction_id: d.interactionId,
        interaction_title: r.title ?? null,
        quote: d.quote,
        summary: summarize(r.item_type, r.proposal ?? {}),
      };
      (d.auto ? out.would_auto_apply : out.would_stay_queued).push(row);
    }
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
  return out;
}

export interface ApplyReport {
  open_before: number;
  open_after: number;
  applied: Array<DryRunRow & { auto_apply_id: number; changed: string[] }>;
  no_longer_eligible: Array<{ review_id: number; rule: string }>;
}

export async function applyApproved(pool: pg.Pool, approved: DryRun, minConfidence = DEFAULT_MIN_CONFIDENCE): Promise<ApplyReport> {
  const count = async () => Number((await pool.query(`select count(*)::int as n from review_queue where status = 'open'`)).rows[0].n);
  const report: ApplyReport = { open_before: await count(), open_after: 0, applied: [], no_longer_eligible: [] };
  for (const row of approved.would_auto_apply) {
    const r = await routeReviewItemTx(pool, row.review_id, { actor: "reevaluate", enabled: true, minConfidence });
    if (r.applied) report.applied.push({ ...row, rule: r.rule, auto_apply_id: r.autoApplyId!, changed: r.changed ?? [] });
    else report.no_longer_eligible.push({ review_id: row.review_id, rule: r.rule });
  }
  report.open_after = await count();
  return report;
}

function dbLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unknown)";
  }
}

export function dryRunMarkdown(d: DryRun): string {
  const line = (r: DryRunRow) =>
    `| ${r.review_id} | ${r.item_type} | ${r.summary.replace(/\|/g, "/")} | \`${r.rule}\`${r.reasons.length > 1 ? ` (+${r.reasons.slice(1).join(", ")})` : ""} | ${r.interaction_id ? `#${r.interaction_id} ${(r.interaction_title ?? "").replace(/\|/g, "/")}` : "—"} | ${r.quote ? `“${r.quote.replace(/\|/g, "/").slice(0, 160)}”` : "—"} |`;
  const table = (rows: DryRunRow[]) => ["| id | type | proposal | rule | source | quote |", "|---|---|---|---|---|---|", ...rows.map(line)].join("\n");
  const byRule = new Map<string, number>();
  for (const r of d.would_stay_queued) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
  return [
    `# Auto-apply dry run — ${d.generated_at.slice(0, 10)}`,
    "",
    `Database: \`${d.database}\` · open items: **${d.open_before}** · would auto-apply: **${d.would_auto_apply.length}** · would stay queued: **${d.would_stay_queued.length}** · min confidence ${d.min_confidence}`,
    "",
    "Nothing has been applied. Applying needs Ben's OK, then `--apply --approved <this file's .json>`.",
    "",
    `## Would auto-apply (${d.would_auto_apply.length})`,
    "",
    d.would_auto_apply.length ? table(d.would_auto_apply) : "_none_",
    "",
    `## Would stay queued (${d.would_stay_queued.length})`,
    "",
    "By rule: " + [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ${v}`).join(" · "),
    "",
    d.would_stay_queued.length ? table(d.would_stay_queued) : "_none_",
    "",
  ].join("\n");
}

function printList(title: string, rows: DryRunRow[]): void {
  console.log(`\n${title} (${rows.length})`);
  for (const r of rows) {
    console.log(`  #${r.review_id}  ${r.item_type.padEnd(24)} ${r.rule}${r.reasons.length > 1 ? ` (+${r.reasons.slice(1).join(", ")})` : ""}`);
    console.log(`        ${r.summary}`);
    console.log(`        source: ${r.interaction_id ? `interaction #${r.interaction_id}${r.interaction_title ? ` "${r.interaction_title}"` : ""}` : "none"}${r.quote ? ` · “${r.quote.slice(0, 160)}”` : ""}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const minConfidence = Number(process.env.AUTO_APPLY_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    if (args.includes("--apply")) {
      const file = flag("--approved");
      if (!file) throw new Error("--apply needs --approved <dry-run.json>: only the dry run Ben approved is applied");
      const approved = JSON.parse(fs.readFileSync(file, "utf8")) as DryRun;
      const report = await applyApproved(pool, approved, minConfidence);
      console.log(`Open review items: before ${report.open_before} → after ${report.open_after}`);
      console.log(`\nAuto-applied (${report.applied.length})`);
      for (const a of report.applied) console.log(`  #${a.review_id} → auto_applies #${a.auto_apply_id}  ${a.rule}  ${a.summary}\n        changed: ${a.changed.join("; ")}${a.quote ? `\n        quote: “${a.quote.slice(0, 160)}”` : ""}`);
      if (report.no_longer_eligible.length) {
        console.log(`\nApproved but no longer eligible, left queued (${report.no_longer_eligible.length})`);
        for (const n of report.no_longer_eligible) console.log(`  #${n.review_id}  ${n.rule}`);
      }
      const out = flag("--out");
      if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
      return;
    }
    const d = await dryRun(pool, minConfidence);
    console.log(`DRY RUN (nothing changed) · ${d.database} · ${d.open_before} open item(s)`);
    printList("WOULD AUTO-APPLY", d.would_auto_apply);
    printList("WOULD STAY QUEUED", d.would_stay_queued);
    const out = flag("--out");
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(d, null, 2));
      fs.writeFileSync(out.replace(/\.json$/, "") + ".md", dryRunMarkdown(d));
      console.log(`\nWrote ${out} and ${out.replace(/\.json$/, "")}.md`);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("reevaluate-review.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
