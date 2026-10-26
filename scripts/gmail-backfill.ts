// npm run messages:gmail -- --account you@example.com [--since 365] [--dry-run] [--max-threads n] [--restart]
//
// Backfills one connected Gmail account (or every active one when --account is omitted) into
// the vault: messages.list "after:<since days>", each thread fetched read-only and run through
// the same filter / redaction / matching / routing as the 10-minute sync. Resumable: the page
// cursor is kept in worker_state, so re-running continues where the last run stopped, and
// re-importing a thread that has not changed writes nothing.
//
// --dry-run fetches and filters but writes nothing at all (not even the cursor) and prints the
// counts it would have written. Suggested order: --dry-run, then --since 30, then the full year.
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { emptyIngestSummary, recordImportRun } from "../server/messages/ingest.ts";
import { backfillGmail, gmailConfigured, listGmailAccounts } from "../server/messages/gmail/sync.ts";

function parseArgs(argv: string[]) {
  const out = { account: null as string | null, since: null as number | null, dryRun: false, maxThreads: null as number | null, restart: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") out.account = String(argv[++i] ?? "").toLowerCase();
    else if (a === "--since") out.since = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max-threads") out.maxThreads = Number(argv[++i]);
    else if (a === "--restart") out.restart = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.since !== null && !(Number.isInteger(out.since) && out.since > 0)) throw new Error("--since takes a whole number of days");
  if (out.maxThreads !== null && !(Number.isInteger(out.maxThreads) && out.maxThreads > 0)) throw new Error("--max-threads takes a positive whole number");
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!gmailConfigured(config)) throw new Error("set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MESSAGES_ENCRYPTION_KEY first (docs/MESSAGES.md)");
  const db = createDb(config.DATABASE_URL);
  try {
    const sinceDays = args.since ?? config.GMAIL_BACKFILL_DAYS;
    console.log(`[gmail] database ${new URL(config.DATABASE_URL).host} · since ${sinceDays} day(s)${args.dryRun ? " · DRY RUN, nothing will be written" : ""}`);
    const accounts = await listGmailAccounts(db.pool, { activeOnly: true, email: args.account ?? undefined });
    if (!accounts.length) throw new Error(args.account ? `no active Gmail account ${args.account}; connect it at /api/messages/gmail/connect` : "no Gmail account connected");
    const log = (line: string) => console.log(`[gmail] ${line}`);
    let exit = 0;
    for (const account of accounts) {
      const summary = emptyIngestSummary(args.dryRun);
      try {
        const r = await backfillGmail(
          { pool: db.pool, config, fetchImpl: fetch, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => new Date(), log },
          account,
          { sinceDays, dryRun: args.dryRun, restart: args.restart, maxThreads: args.maxThreads ?? undefined },
          summary,
        );
        if (!args.dryRun) await recordImportRun(db.pool, "gmail", summary, { mode: "backfill", account: account.accountEmail, since_days: sinceDays, done: r.done });
        console.log(`[gmail] ${account.accountEmail}: ${r.threads} thread(s) read with ${r.apiCalls} API call(s)${r.done ? ", backfill complete" : ", not finished: run again to continue"}`);
        console.log(`  threads   ${summary.created} ${args.dryRun ? "would be new" : "new"} · ${summary.updated} updated · ${summary.unchanged} unchanged · ${summary.emptyThreads} entirely filtered`);
        console.log(`  messages  ${summary.messagesIn} read · ${summary.messagesStored} stored · ${summary.redactions} redaction(s)`);
        console.log(`  skipped   ${Object.entries(summary.skipped).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing"}`);
        console.log(`  routed    ${Object.entries(summary.routed).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing"}`);
        console.log(`  review    ${summary.reviewNewParty} unknown sender(s) · ${summary.reviewWorkspace} workspace decision(s)`);
        if (summary.errors.length) {
          exit = 1;
          for (const e of summary.errors.slice(0, 10)) console.log(`  error     ${e}`);
        }
      } catch (err) {
        exit = 1;
        console.error(`[gmail] ${account.accountEmail}: ${(err as Error).message}`);
      }
    }
    return exit;
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
