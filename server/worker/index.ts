// `npm run worker` - the Strout Vault worker. Runs once and exits (what a
// Replit Scheduled Deployment wants); `--loop [minutes]` keeps going for a VM.
//
//   npm run worker                 one run: zoom sync, transcription, report
//   npm run worker -- --report     print the pipeline report and exit
//   npm run worker -- --dry-run    enumerate Zoom, download nothing
//   npm run worker -- --steps transcribe
//   npm run worker -- --loop 30    run every 30 minutes until stopped
//   WORKER_STEPS=gmail,embed       the steps to run when --steps is not given (the 10-minute
//                                  messages deployment; docs/MESSAGES.md)

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createStorage } from "../storage/index.ts";
import type { WorkerContext } from "./context.ts";
import { buildReport } from "./report.ts";
import { ALL_STEPS, formatRunSummary, runWorker, type Step } from "./run.ts";
import { toolsAvailable } from "./media.ts";

function parseArgs(argv: string[]) {
  const out = { loopMinutes: 0, report: false, dryRun: false, steps: undefined as Step[] | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--loop") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) i++;
      out.loopMinutes = Number.isFinite(n) && n > 0 ? n : 60;
    } else if (a === "--report") out.report = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--steps") {
      out.steps = String(argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is Step => (ALL_STEPS as string[]).includes(s));
    } else if (a === "--once") {
      /* default */
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!args.steps && config.WORKER_STEPS) args.steps = parseArgs(["--steps", config.WORKER_STEPS]).steps;
  const dbHandle = createDb(config.DATABASE_URL);
  const storage = createStorage(config);
  const tmpDir = config.WORKER_TMP_DIR ?? path.join(os.tmpdir(), "strout-vault-worker");
  fs.mkdirSync(tmpDir, { recursive: true });
  const log = (line: string) => console.log(`[worker ${new Date().toISOString()}] ${line}`);
  const tools = { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN };

  const makeCtx = (): WorkerContext => ({
    config,
    pool: dbHandle.pool,
    storage,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log,
    tmpDir,
    tools,
    deadline: Date.now() + config.WORKER_TIME_BUDGET_SEC * 1000,
    bytesBudget: config.WORKER_MAX_BYTES_PER_RUN,
  });

  try {
    if (args.report) {
      const report = await buildReport(dbHandle.pool, new Date());
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    const tools$ = await toolsAvailable(tools);
    if (!tools$.ok) log(`warning: ${tools$.error}. Groq transcription will fail until ffmpeg is available; Zoom transcripts still work.`);
    log(`storage=${storage.name}, archive=${storage.archiveTarget.storage}${storage.archiveTarget.bucket ? `:${storage.archiveTarget.bucket}` : ""}, groq=${config.GROQ_API_KEY ? `on (budget $${config.GROQ_MONTHLY_BUDGET_USD}/month)` : "off"}`);
    let exit = 0;
    do {
      const result = await runWorker(makeCtx(), { trigger: args.loopMinutes ? "manual" : "schedule", steps: args.steps, dryRun: args.dryRun });
      console.log(formatRunSummary(result.summary));
      exit = result.ok ? 0 : 1;
      if (args.loopMinutes) {
        log(`next run in ${args.loopMinutes} minute(s)`);
        await new Promise((r) => setTimeout(r, args.loopMinutes * 60_000));
      }
    } while (args.loopMinutes);
    return exit;
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
