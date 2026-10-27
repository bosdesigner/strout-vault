// npm run messages:meet -- --account you@example.com [--since 90] [--dry-run]
//
// Backfills Google Meet recordings for one connected Meet account (or every one when --account
// is omitted): Drive files.list for Meet recordings created in the last --since days (default
// 90), each new one recorded with its transcript Doc and participants, then downloaded into the
// archive bucket like the hourly meet step does. Re-running is safe: recordings already in the
// vault (source_ref meet:<account>:<file id>) are skipped; the account's hourly cursor is left
// alone. Transcription happens on the worker's next run (Meet's transcript first, Groq otherwise).
//
// --dry-run lists and counts (new recordings, transcripts, bytes it would download) and writes
// nothing at all. Suggested order: --dry-run, then --since 30, then the full window.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { createStorage } from "../server/storage/index.ts";
import { gmailConfigured } from "../server/messages/gmail/sync.ts";
import { syncMeet } from "../server/meet/sync.ts";

function parseArgs(argv: string[]) {
  const out = { account: undefined as string | undefined, since: 90, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") out.account = String(argv[++i] ?? "").toLowerCase();
    else if (a === "--since") out.since = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(Number.isInteger(out.since) && out.since > 0)) throw new Error("--since takes a whole number of days");
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!gmailConfigured(config)) throw new Error("set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MESSAGES_ENCRYPTION_KEY first (docs/INGEST.md)");
  const db = createDb(config.DATABASE_URL);
  const tmpDir = path.join(os.tmpdir(), "strout-vault-meet");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    console.log(`[meet] database ${new URL(config.DATABASE_URL).host} · since ${args.since} day(s)${args.dryRun ? " · DRY RUN, nothing will be written" : ""}`);
    const summary = await syncMeet(
      {
        config,
        pool: db.pool,
        storage: createStorage(config),
        fetchImpl: fetch,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => new Date(),
        log: (line) => console.log(`[meet] ${line}`),
        tmpDir,
        tools: { ffmpeg: config.FFMPEG_BIN, ffprobe: config.FFPROBE_BIN },
        deadline: Date.now() + config.WORKER_TIME_BUDGET_SEC * 1000,
        bytesBudget: config.WORKER_MAX_BYTES_PER_RUN,
      },
      { dryRun: args.dryRun, account: args.account, sinceDays: args.since },
    );
    if (summary.skipped) throw new Error(`${summary.skipped}; connect an account at /api/messages/meet/connect`);
    for (const a of summary.accounts) {
      console.log(`[meet] ${a.account}: ${a.error ? `FAILED ${a.error}` : `${a.recordingsSeen} recording(s) in the window, ${a.recordingsNew} ${args.dryRun ? "would be new" : "new"}, ${a.transcripts} with a transcript${a.capability === "none_found" ? " (no Meet recordings on this account)" : ""}`}`);
    }
    if (args.dryRun) console.log(`[meet] would download ${(summary.bytesPending / 1024 / 1024).toFixed(1)} MB`);
    else console.log(`[meet] downloaded ${summary.filesVerified} recording(s) (${(summary.bytes / 1024 / 1024).toFixed(1)} MB), ${summary.filesFailed} failed${summary.stoppedEarly ? `; stopped early (${summary.stoppedEarly}): run again to continue` : ""}`);
    for (const e of summary.errors.slice(0, 10)) console.log(`  error     ${e}`);
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
