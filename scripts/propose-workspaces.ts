// npm run workspaces:propose -- [--apply] [--min-confidence 0.6] [--limit n] [--workspace id] [--show 30]
//
// Guesses a workspace for every recording that has none (title rules, known people in the
// title, transcript keyword majority; server/workspaces/rules.ts) and prints what it would
// propose. Dry run by default. With --apply it queues one review item per recording; the
// owner approves them on the Review page ("Approve all" works per page), and approval is what
// writes interactions.workspace_id. Nothing is assigned by this script itself.
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { proposeWorkspaces, queueProposals } from "../server/workspaces/propose.ts";

function parseArgs(argv: string[]) {
  const out = { apply: false, minConfidence: 0.6, limit: null as number | null, workspace: null as string | null, show: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--min-confidence") out.minConfidence = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--workspace") out.workspace = String(argv[++i] ?? "");
    else if (a === "--show") out.show = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(out.minConfidence >= 0 && out.minConfidence <= 1)) throw new Error("--min-confidence must be between 0 and 1");
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dbHandle = createDb(config.DATABASE_URL);
  const pool = dbHandle.pool;
  try {
    const host = new URL(config.DATABASE_URL).host;
    console.log(`[workspaces] database ${host}${args.apply ? "" : " · DRY RUN, nothing will be written"}`);
    const report = await proposeWorkspaces(pool, { minConfidence: args.minConfidence, limit: args.limit ?? undefined, onlyWorkspace: args.workspace ?? undefined });
    console.log(`[workspaces] ${report.candidates} recording(s) without a workspace; ${report.proposed.length} proposal(s), ${report.undecided.length} undecided, ${report.skippedOpenProposal} already waiting for review`);
    console.log("");
    console.log("  by workspace:");
    for (const [ws, n] of Object.entries(report.byWorkspace).sort((a, b) => b[1] - a[1])) console.log(`    ${ws.padEnd(18)} ${String(n).padStart(5)}`);
    console.log(`  by confidence:   high (≥85%) ${report.byConfidence.high} · medium (70-84%) ${report.byConfidence.medium} · low (60-69%) ${report.byConfidence.low}`);
    console.log("");
    console.log(`  sample of what would be proposed (first ${args.show}):`);
    for (const p of report.proposed.slice(0, args.show)) console.log(`    #${String(p.interactionId).padEnd(6)} ${p.workspaceId.padEnd(17)} ${Math.round(p.confidence * 100)}%  ${p.evidence.join("; ")}`);
    if (report.undecided.length) {
      console.log("");
      console.log(`  undecided (first ${Math.min(args.show, report.undecided.length)} of ${report.undecided.length}): left alone for a human`);
      for (const u of report.undecided.slice(0, args.show)) console.log(`    #${String(u.interactionId).padEnd(6)} ${JSON.stringify((u.title ?? "").slice(0, 60)).padEnd(64)} ${u.reason}`);
    }
    console.log("");
    if (!args.apply) {
      console.log("  Nothing was written. Re-run with --apply to queue these for review, or tune server/workspaces/rules.ts first.");
      return 0;
    }
    const ids = await queueProposals(pool, report.proposed, "workspace-proposer");
    console.log(`  queued ${ids.length} review item(s). Open /review, filter to all workspaces, and use "Approve all workspace proposals" page by page.`);
    return 0;
  } finally {
    await dbHandle.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
