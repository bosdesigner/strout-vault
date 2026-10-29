// npm run extract:backfill -- [--phase recent|rest|all] [--days 30] [--rpm 20] [--batch 25] [--max-batches N] [--dry-run]
//
// Runs extraction over every interaction that has text and has not been read yet: recordings,
// calls, voice memos, Apple Notes, texts and email, in every workspace EXTRACT_WORKSPACES allows.
// Start with --phase recent (the last --days, default 30), then --phase rest (everything older).
//
// Rate-limited: --rpm spaces Claude requests (default 20 a minute). Resumable: progress lives on
// the interactions themselves (extracted_at, extracted_through_idx), so stopping and starting again
// carries on where it left off, and a re-run never reads anything twice. Each batch takes the
// worker lock, so it never overlaps the hourly run (it waits for it instead). Progress is printed
// per batch and kept in worker_state (key extract_backfill) for the Pipeline page.
//
// Money: the same EXTRACT_MONTHLY_BUDGET_USD ceiling as the hourly step; the backfill stops at it.
// --dry-run counts what is waiting and estimates the cost, and sends nothing.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { createStorage } from "../server/storage/index.ts";
import type { WorkerContext } from "../server/worker/context.ts";
import { runWorker, formatRunSummary } from "../server/worker/run.ts";
import { setState } from "../server/worker/sync.ts";
import { extractWorkspaces, THREAD_KINDS } from "../server/worker/extract.ts";
import { estimateScoutCostUsd, priceFor } from "../server/worker/scout.ts";
import { monthToDateSpend } from "../server/worker/budget.ts";

function parseArgs(argv: string[]) {
  const out = { phase: "recent" as "recent" | "rest" | "all", days: 30, rpm: 20, batch: 25, maxBatches: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phase") {
      const v = String(argv[++i] ?? "");
      if (v !== "recent" && v !== "rest" && v !== "all") throw new Error("--phase is recent, rest or all");
      out.phase = v;
    } else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--rpm") out.rpm = Number(argv[++i]);
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else if (a === "--max-batches") out.maxBatches = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const [k, v] of Object.entries({ days: out.days, rpm: out.rpm, batch: out.batch })) if (!(Number.isFinite(v) && v > 0)) throw new Error(`--${k} takes a positive number`);
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = { ...loadConfig(), EXTRACT_RPM: args.rpm };
  const db = createDb(config.DATABASE_URL);
  const tmpDir = path.join(os.tmpdir(), "strout-vault-extract");
  fs.mkdirSync(tmpDir, { recursive: true });
  const log = (line: string) => console.log(`[extract-backfill ${new Date().toISOString().slice(11, 19)}] ${line}`);
  const cutoff = new Date(Date.now() - args.days * 86_400_000);
  const since = args.phase === "recent" ? cutoff : undefined;
  const until = args.phase === "rest" ? cutoff : undefined;
  const ctx = (): WorkerContext => ({
    config,
    pool: db.pool,
    storage: createStorage(config),
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log,
    tmpDir,
    tools: { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN },
    deadline: Date.now() + config.WORKER_TIME_BUDGET_SEC * 1000,
    bytesBudget: 0,
  });
  try {
    const workspaces = await extractWorkspaces(db.pool, config.EXTRACT_WORKSPACES);
    log(`database ${new URL(config.DATABASE_URL).host} · phase ${args.phase} (${since ? `since ${since.toISOString().slice(0, 10)}` : until ? `before ${until.toISOString().slice(0, 10)}` : "everything"}) · workspaces ${workspaces.join(", ")} · ${args.rpm} request(s)/min${args.dryRun ? " · DRY RUN, nothing is sent" : ""}`);

    // What is waiting, and roughly what it costs (the same estimate the step checks the budget with).
    const params: unknown[] = [workspaces, THREAD_KINDS];
    const window = [since ? `and coalesce(i.occurred_at, i.created_at) >= $${params.push(since)}` : "", until ? `and coalesce(i.occurred_at, i.created_at) < $${params.push(until)}` : ""].join(" ");
    const { rows } = await db.pool.query(
      `select i.kind, count(*)::int as n, coalesce(sum(w.words), 0)::bigint as words
         from interactions i
         join lateral (select sum(array_length(regexp_split_to_array(s.text, '\\s+'), 1)) as words, max(s.idx) as max_idx from segments s where s.interaction_id = i.id) w on w.max_idx is not null
        where i.workspace_id = any($1::text[]) ${window}
          and ((i.kind <> all($2::text[]) and i.extracted_at is null) or (i.kind = any($2::text[]) and w.max_idx > coalesce(i.extracted_through_idx, -1)))
        group by 1 order by 2 desc`,
      params,
    );
    const model = config.EXTRACT_MODEL;
    let total = 0;
    let usd = 0;
    for (const r of rows) {
      const calls = Math.max(Number(r.n), Math.ceil(Number(r.words) / 3000));
      const est = estimateScoutCostUsd(Number(r.words), calls, model) + (calls * 2500 * priceFor(model).in) / 1_000_000;
      total += Number(r.n);
      usd += est;
      log(`  waiting: ${String(r.n).padStart(5)} ${r.kind.padEnd(13)} ~${Number(r.words).toLocaleString()} words, ~$${est.toFixed(2)}`);
    }
    const spent = await monthToDateSpend(db.pool, "anthropic-extract", new Date());
    log(`  total ${total} item(s), ~$${usd.toFixed(2)} on ${model} (estimate); this month so far $${spent.toFixed(2)} of $${config.EXTRACT_MONTHLY_BUDGET_USD} budget`);
    if (args.dryRun || !total) return 0;
    if (!config.ANTHROPIC_API_KEY || config.EXTRACT_MONTHLY_BUDGET_USD <= 0) throw new Error("set ANTHROPIC_API_KEY and EXTRACT_MONTHLY_BUDGET_USD on this Repl first (docs/EXTRACTION.md)");

    const progress = { phase: args.phase, startedAt: new Date().toISOString(), batches: 0, read: 0, written: 0, merged: 0, queued: 0, failed: 0, spentUsd: 0, waiting: total };
    let lockedWaits = 0;
    for (let b = 0; b < args.maxBatches; b++) {
      const result = await runWorker(ctx(), {
        trigger: "manual",
        steps: ["extract"],
        extract: { since, until, threadsSince: since ?? null, maxPerRun: args.batch, threadsPerRun: args.batch },
      });
      if (result.summary.skipped === "locked") {
        if (++lockedWaits > 60) throw new Error("the worker lock stayed busy for an hour; try again later");
        log("the hourly run holds the worker lock; waiting a minute");
        await new Promise((r) => setTimeout(r, 60_000));
        b--;
        continue;
      }
      const x = result.summary.extract;
      if (!x) break;
      progress.batches++;
      progress.read += x.read;
      progress.written += x.written.facts;
      progress.merged += x.written.merged;
      progress.queued += x.queued.facts + x.queued.speakers + x.queued.projects;
      progress.failed += x.failed;
      progress.spentUsd += x.spentUsd;
      progress.waiting = Math.max(0, progress.waiting - x.read);
      await setState(ctx(), "extract_backfill", { ...progress, updatedAt: new Date().toISOString() });
      log(`batch ${progress.batches}: ${formatRunSummary(result.summary).split("\n")[0]}`);
      log(`  so far: ${progress.read} read, ${progress.written} fact(s) written, ${progress.merged} merged, ${progress.queued} proposal(s) queued, ${progress.failed} failed, $${progress.spentUsd.toFixed(2)}; ~${progress.waiting} waiting`);
      if (x.stoppedEarly === "extract budget" || x.stoppedEarly === "api key refused") {
        log(`stopped: ${x.stoppedEarly}. Raise EXTRACT_MONTHLY_BUDGET_USD (or wait for next month) and run the same command again to carry on.`);
        break;
      }
      // Nothing left to read in this window (failures are not retried here; they stay on the Pipeline page).
      if (x.read === 0 || x.read + x.failed === 0) break;
    }
    log(`done: ${progress.read} read, ${progress.written} fact(s) written, ${progress.merged} merged into facts on record, $${progress.spentUsd.toFixed(2)} spent`);
    return progress.failed ? 1 : 0;
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
