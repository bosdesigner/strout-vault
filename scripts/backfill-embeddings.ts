// npm run embed:backfill -- [--dry-run] [--workspace <id>] [--limit <n>] [--concurrency <n>] [--retry-failed] [--yes]
//
// Chunks and embeds every transcribed recording that has no current embedding, using the
// provider in EMBEDDING_PROVIDER and the app's normal DATABASE_URL (the roles the MCP server
// uses are read-only). Resumable: recordings that already have embedded chunks are skipped,
// so it can be stopped and restarted. Each recording is one transaction.
//
//   --dry-run        count recordings, chunks and tokens and estimate the cost; write nothing
//   --workspace id   only this workspace (a small first pass)
//   --limit n        at most n recordings, newest first
//   --concurrency n  recordings in flight at once (default EMBED_CONCURRENCY, 2)
//   --retry-failed   include recordings whose attempts are exhausted
//   --yes            required for a real run against a database that is not on localhost
//   --allow-fake     allow the fake provider against a remote database (never in production)
//
// Run it in this order: --dry-run, then --workspace <one> --limit 20, then the full run.
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { createEmbeddingProvider, type EmbeddingProvider } from "../server/embeddings/provider.ts";
import { embedInteraction, listEmbedCandidates, planInteraction, type EmbedCandidate } from "../server/embeddings/pipeline.ts";

function parseArgs(argv: string[]) {
  const out = { dryRun: false, workspace: null as string | null, limit: null as number | null, concurrency: null as number | null, retryFailed: false, yes: false, allowFake: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--workspace") out.workspace = String(argv[++i] ?? "");
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--retry-failed") out.retryFailed = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--allow-fake") out.allowFake = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.limit !== null && !(Number.isInteger(out.limit) && out.limit > 0)) throw new Error("--limit needs a positive integer");
  if (out.concurrency !== null && !(Number.isInteger(out.concurrency) && out.concurrency > 0)) throw new Error("--concurrency needs a positive integer");
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
const isLocal = (url: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostOf(url));
const money = (usd: number) => (usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`);
const log = (line: string) => console.log(`[embed:backfill ${new Date().toISOString().slice(11, 19)}] ${line}`);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dbHost = hostOf(config.DATABASE_URL);
  const local = isLocal(config.DATABASE_URL);

  let provider: EmbeddingProvider | null;
  try {
    provider = createEmbeddingProvider(config, { fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (!provider) {
    console.error("EMBEDDING_PROVIDER=off: set it to voyage (with VOYAGE_API_KEY) or openai first. Nothing to do.");
    return 2;
  }
  if (provider.name === "fake" && !local && !args.allowFake) {
    console.error(`refusing to write fake embeddings into a remote database (${dbHost}). Use a real provider, or --allow-fake if you really mean it.`);
    return 2;
  }
  if (!args.dryRun && !local && !args.yes) {
    console.error(`this is a real run against ${dbHost}, not localhost. Re-run with --dry-run first, then add --yes.`);
    return 2;
  }

  const dbHandle = createDb(config.DATABASE_URL);
  const pool = dbHandle.pool;
  try {
    log(`database ${dbHost} · provider ${provider.name} ${provider.model} (${provider.dimensions} dims, $${provider.usdPerMillionTokens}/M tokens)${args.dryRun ? " · DRY RUN, nothing will be written" : ""}`);
    const candidates = await listEmbedCandidates(pool, { workspaceId: args.workspace, limit: args.limit ?? undefined, retryFailed: args.retryFailed });
    const already = await pool.query(`select count(*)::int as n from interactions where embedded_at is not null`);
    log(`${candidates.length} recording(s) to embed${args.workspace ? ` in ${args.workspace}` : ""}${args.limit ? ` (limit ${args.limit})` : ""}; ${already.rows[0].n} already embedded and skipped`);
    if (!candidates.length) return 0;

    if (args.dryRun) return await dryRun(pool, provider, candidates);

    const concurrency = args.concurrency ?? config.EMBED_CONCURRENCY;
    let done = 0;
    let failed = 0;
    let chunks = 0;
    let tokens = 0;
    let n = 0;
    const started = Date.now();
    const queue = [...candidates];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift()!;
        const i = ++n;
        const label = `#${c.id} ${JSON.stringify((c.title ?? "").slice(0, 60))}`;
        const t0 = Date.now();
        try {
          const out = await embedInteraction(pool, provider!, c.id);
          if (out.skipped) {
            log(`[${i}/${candidates.length}] ${label}: skipped (${out.skipped})`);
            continue;
          }
          done++;
          chunks += out.chunks.length;
          tokens += out.tokens;
          log(`[${i}/${candidates.length}] ${label}: ${out.chunks.length} chunks, ~${out.tokens} tokens, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
          failed++;
          log(`[${i}/${candidates.length}] ${label}: FAILED ${(err as Error).message.slice(0, 200)}`);
          if (failed >= 5 && done === 0) {
            log("five failures and no success: stopping (check the key and the provider status)");
            queue.length = 0;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const secs = (Date.now() - started) / 1000;
    const reported = (provider as { reportedTokens?: number }).reportedTokens;
    log(`done: ${done} embedded, ${failed} failed, ${chunks} chunks, ~${tokens} tokens estimated${reported ? ` (${reported} billed by the provider)` : ""}, ~${money(((reported || tokens) / 1e6) * provider.usdPerMillionTokens)} in ${secs.toFixed(0)}s`);
    if (failed) log("failed recordings keep their embed_error and are retried by the hourly worker, or re-run this script");
    return failed && !done ? 1 : 0;
  } finally {
    await dbHandle.close();
  }
}

/** Runs the chunker over every candidate in memory and prints the totals. Writes nothing. */
async function dryRun(pool: ReturnType<typeof createDb>["pool"], provider: EmbeddingProvider, candidates: EmbedCandidate[]): Promise<number> {
  const perWorkspace = new Map<string, { recordings: number; chunks: number; tokens: number }>();
  let chunks = 0;
  let tokens = 0;
  let segments = 0;
  let noSegments = 0;
  let i = 0;
  for (const c of candidates) {
    const plan = await planInteraction(pool, c.id);
    if (!plan.chunks.length) noSegments++;
    chunks += plan.chunks.length;
    tokens += plan.tokens;
    segments += c.segment_count;
    const ws = c.workspace_id ?? "(no workspace)";
    const w = perWorkspace.get(ws) ?? { recordings: 0, chunks: 0, tokens: 0 };
    w.recordings++;
    w.chunks += plan.chunks.length;
    w.tokens += plan.tokens;
    perWorkspace.set(ws, w);
    if (++i % 100 === 0) log(`planned ${i}/${candidates.length}…`);
  }
  const usd = (tokens / 1e6) * provider.usdPerMillionTokens;
  console.log("");
  console.log(`  recordings      ${candidates.length}${noSegments ? ` (${noSegments} without segments, skipped)` : ""}`);
  console.log(`  segments        ${segments}`);
  console.log(`  chunks          ${chunks}`);
  console.log(`  tokens (est.)   ${tokens.toLocaleString("en-US")}  (~4 chars per token; includes the ~15% overlap and speaker labels)`);
  console.log(`  cost (est.)     ${money(usd)} at $${provider.usdPerMillionTokens} per million tokens on ${provider.name} ${provider.model}`);
  console.log("");
  console.log("  by workspace:");
  for (const [ws, w] of [...perWorkspace.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`    ${ws.padEnd(20)} ${String(w.recordings).padStart(5)} recordings ${String(w.chunks).padStart(7)} chunks ${w.tokens.toLocaleString("en-US").padStart(12)} tokens  ${money((w.tokens / 1e6) * provider.usdPerMillionTokens)}`);
  }
  console.log("");
  console.log("  Nothing was written. Next: a small pass, e.g. --workspace <id> --limit 20, then the full run.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
