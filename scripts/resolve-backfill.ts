// npm run resolve:backfill -- [--apply] [--since YYYY-MM-DD] [--sources zoom,meet,iphone_call] [--limit N] [--again] [--report path.md]
//
// Links every Zoom / Meet recording and iPhone call that came in unfiled or with nobody on it to its
// people, and files the ones that settles (title rules in config/filing_rules.yml first, then the
// people's workspaces). The same code as the worker's hourly `resolve` step.
//
// DRY RUN BY DEFAULT: everything runs inside one transaction that is rolled back, so the report
// shows exactly what --apply would do and nothing is kept. Order: dry run, read the report, then
// --apply. Re-running --apply is safe: an interaction is resolved once (participants_resolved_at)
// unless --again is given, existing links are never removed, and a filed interaction is never moved.
//
// To undo an --apply as a set:
//   delete from interaction_participants where resolved_by is not null;   -- links it made
//   update interactions set workspace_id = null, filed_by = null where filed_by like 'rule:%' or filed_by = 'participants';
//   (parties it created carry external_refs->>'created_by' = 'participant-resolver')
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { createStorage } from "../server/storage/index.ts";
import { processResolve } from "../server/worker/resolve.ts";

function parseArgs(argv: string[]) {
  const out = { apply: false, since: undefined as Date | undefined, sources: undefined as string[] | undefined, limit: 100_000, again: false, report: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
    else if (a === "--since") out.since = new Date(String(argv[++i]));
    else if (a === "--sources") out.sources = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--again") out.again = true;
    else if (a === "--report") out.report = String(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.since && Number.isNaN(out.since.getTime())) throw new Error("--since takes a date (YYYY-MM-DD)");
  return out;
}

async function counts(pool: import("pg").Pool | import("pg").PoolClient) {
  const { rows } = await pool.query(
    `select count(*) filter (where workspace_id is null)::int as null_workspace,
            count(*) filter (where not exists (select 1 from interaction_participants ip where ip.interaction_id = i.id))::int as no_participants,
            count(*) filter (where source = 'zoom' and workspace_id is null)::int as zoom_null_workspace,
            count(*) filter (where source = 'zoom' and not exists (select 1 from interaction_participants ip where ip.interaction_id = i.id))::int as zoom_no_participants,
            count(*) filter (where source = 'iphone_call' and not exists (select 1 from interaction_participants ip where ip.interaction_id = i.id))::int as calls_no_participants
       from interactions i`,
  );
  return rows[0] as Record<string, number>;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const tmpDir = path.join(os.tmpdir(), "strout-vault-resolve");
  fs.mkdirSync(tmpDir, { recursive: true });
  const log = (line: string) => console.log(`[resolve-backfill] ${line}`);
  try {
    log(`database ${new URL(config.DATABASE_URL).host}${args.apply ? " · APPLY: changes are kept" : " · DRY RUN: everything is rolled back (pass --apply to keep it)"}`);
    const before = await counts(db.pool);
    const summary = await processResolve(
      {
        config,
        pool: db.pool,
        storage: createStorage(config),
        fetchImpl: fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => new Date(),
        log,
        tmpDir,
        tools: { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN },
        deadline: Date.now() + 6 * 3600 * 1000,
        bytesBudget: 0,
      },
      { dryRun: !args.apply, since: args.since, sources: args.sources, limit: args.limit, again: args.again, keepResults: true, inspect: (c) => counts(c) },
    );
    const after = summary.inspected ?? (await counts(db.pool));
    const filed = Object.entries(summary.filed);
    const resolvedRows = summary.results ?? [];
    const lines = [
      `# Participant and filing backfill (${args.apply ? "applied" : "dry run"}, ${new Date().toISOString().slice(0, 16)}Z)`,
      "",
      `- checked ${summary.checked} recording(s)/call(s); ${summary.linked} participant link(s), ${summary.partiesCreated} new part(ies), ${summary.leadsLinked} link(s) to leads, ${summary.suggested} suggested match(es) for Review`,
      `- filed: ${filed.length ? filed.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`,
      `- zoom participant list: ${summary.zoomApi}; calendar: ${summary.calendar}`,
      `- errors: ${summary.errors.length}${summary.errors.length ? `\n  - ${summary.errors.slice(0, 20).join("\n  - ")}` : ""}`,
      "",
      `| | before | ${args.apply ? "after" : "after (inside the rolled-back transaction)"} |`,
      "|---|---|---|",
      ...Object.keys(before).map((k) => `| ${k.replace(/_/g, " ")} | ${before[k]} | ${after[k] ?? ""} |`),
    ];
    lines.push("", "| # | title | before → after | linked (via) | suggested |", "|---|---|---|---|---|");
    for (const r of resolvedRows) {
      if (!r.linked.length && !r.suggested.length && r.workspaceAfter === r.workspaceBefore) continue;
      const linked = r.linked.map((l) => `${l.name} (${l.via}${l.how === "created" ? ", new" : ""}${l.isLead ? ", lead" : ""})`).join("; ");
      const sugg = r.suggested.map((s) => `${s.candidate} ≈ ${s.name}`).join("; ");
      lines.push(`| ${r.interactionId} | ${(r.title ?? "").replace(/\|/g, "/").slice(0, 70)} | ${r.workspaceBefore ?? "unassigned"} → ${r.workspaceAfter ?? "unassigned"}${r.filedBy ? ` (${r.filedBy})` : ""} | ${linked} | ${sugg} |`);
    }
    const unresolved = resolvedRows.flatMap((r) => r.unresolved.map((u) => `#${r.interactionId}: ${u}`));
    if (unresolved.length) lines.push("", `Unresolved names (not created: a first name alone, or shared by several people): ${unresolved.length}`, ...unresolved.slice(0, 200).map((u) => `- ${u}`));
    const text = lines.join("\n") + "\n";
    if (args.report) {
      fs.writeFileSync(args.report, text);
      log(`report written to ${args.report}`);
    } else console.log(text);
    return summary.errors.length ? 1 : 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
