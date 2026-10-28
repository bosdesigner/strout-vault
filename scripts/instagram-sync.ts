// npm run messages:instagram -- [--account username] [--backfill] [--dry-run]
//
// One pass over the connected Instagram account(s), from a Repl shell: the same pass the worker's
// instagram step runs every 10 minutes. --backfill reads every conversation the API still returns
// instead of only those changed since the last pass (the API gives the 20 newest messages of each;
// older history is out of its reach, see docs/SOCIAL_DMS.md). --dry-run reads and filters but writes
// nothing at all (not the cursor, not a refreshed token) and prints the counts it would have written.
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { instagramConfigured, syncInstagram } from "../server/messages/instagram/sync.ts";

function parseArgs(argv: string[]) {
  const out = { account: null as string | null, dryRun: false, backfill: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") out.account = String(argv[++i] ?? "").replace(/^@/, "").toLowerCase();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--backfill") out.backfill = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!instagramConfigured(config)) throw new Error("set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and MESSAGES_ENCRYPTION_KEY first (docs/SOCIAL_DMS.md)");
  const db = createDb(config.DATABASE_URL);
  try {
    console.log(`[instagram] database ${new URL(config.DATABASE_URL).host}${args.backfill ? " · backfill" : ""}${args.dryRun ? " · DRY RUN, nothing will be written" : ""}`);
    const s = await syncInstagram(
      { pool: db.pool, config, fetchImpl: fetch, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => new Date(), log: (line) => console.log(`[instagram] ${line}`) },
      { dryRun: args.dryRun, backfill: args.backfill, username: args.account ?? undefined },
    );
    if (s.skipped) {
      console.log(`[instagram] skipped: ${s.skipped}${s.skipped.startsWith("no Instagram") ? "; connect one at /api/messages/instagram/connect" : ""}`);
      return 1;
    }
    const i = s.ingest;
    console.log(`  threads   ${i.created} ${args.dryRun ? "would be new" : "new"} · ${i.updated} updated · ${i.unchanged} unchanged · ${i.emptyThreads} entirely filtered`);
    console.log(`  messages  ${i.messagesIn} read · ${i.messagesStored} stored · ${i.redactions} redaction(s)`);
    console.log(`  skipped   ${Object.entries(i.skipped).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing"}`);
    console.log(`  routed    ${Object.entries(i.routed).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing"}`);
    console.log(`  review    ${i.reviewNewParty} unknown account(s) · ${i.reviewWorkspace} workspace decision(s)`);
    for (const e of [...s.errors, ...i.errors].slice(0, 10)) console.log(`  error     ${e}`);
    return s.errors.length || i.errors.length ? 1 : 0;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[instagram] ${(err as Error).message}`);
    process.exit(1);
  },
);
