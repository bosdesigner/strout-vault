// npm run mcp:semantic-check
//
// Semantic-search quality check against the seed (docs/mcp-verification/semantic-check.md):
// embeds the seeded recordings with the configured EMBEDDING_PROVIDER into the LOCAL database
// named by DATABASE_URL, then runs five paraphrased queries that share no keywords with the
// passage they target and reports whether the right recording is in the top 3. Refuses any
// database that is not on localhost. With EMBEDDING_PROVIDER=fake the queries are expected to
// miss (hashed words cannot match paraphrases); run it with voyage or openai for the real result.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { createDb } from "../server/db/client.ts";
import { createEmbeddingProvider } from "../server/embeddings/provider.ts";
import { embedInteraction, listEmbedCandidates } from "../server/embeddings/pipeline.ts";
import { searchConversations } from "../server/mcp/tools/search.ts";
import { resolveScope } from "../server/mcp/scope.ts";
import type { ToolContext } from "../server/mcp/tools/types.ts";
import { REPO_ROOT } from "./lib/localdb.ts";

/** Query → the title of the one seeded recording that holds the matching passage (scripts/gen-seed.ts, DISTINCTIVE). */
export const CHECKS: Array<{ query: string; expectTitle: string; passage: string }> = [
  { query: "investor asking for governance perks and a lower valuation before committing", expectTitle: "Harbor Point seed terms", passage: "board observer seat … pro rata right … pushed the pre-money down" },
  { query: "keeping the trial engagement small enough that the customer can sign off quickly", expectTitle: "Phalanx pilot scope with Daniel", passage: "cap the pilot at one site and ninety days … approve it without waiting for a budget cycle" },
  { query: "lumber availability problem forcing a material change or a schedule delay", expectTitle: "Gulf Coast Millwork stock check", passage: "cypress on the floor today but the cedar is three weeks out … switch species or push the install" },
  { query: "dawn aerial footage then a sit-down conversation with the person who started the company", expectTitle: "Conroe shoot day planning", passage: "shoot at sunrise so the drone pass clears … founder interview on the shop floor" },
  { query: "deadline for public energy funding and the local government endorsement it needs", expectTitle: "SEPP grant application strategy", passage: "state efficiency grant closes in March … county letter of support" },
];

const isLocal = (url: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);

async function main(): Promise<number> {
  const config = loadConfig();
  if (!isLocal(config.DATABASE_URL)) {
    console.error("semantic-check only runs against a localhost database (it embeds the seed). Set DATABASE_URL from `npm run db:local`.");
    return 2;
  }
  const provider = createEmbeddingProvider(config, { fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l) });
  if (!provider) {
    console.error("EMBEDDING_PROVIDER=off; set voyage, openai or fake.");
    return 2;
  }
  const dbHandle = createDb(config.DATABASE_URL);
  const pool = dbHandle.pool;
  try {
    const started = Date.now();
    const pending = await listEmbedCandidates(pool);
    console.log(`provider ${provider.name} ${provider.model}; embedding ${pending.length} recording(s) that have no current embedding…`);
    let chunks = 0;
    for (const c of pending) {
      const out = await embedInteraction(pool, provider, c.id);
      chunks += out.chunks.length;
    }
    const total = await pool.query(`select count(*)::int as n from chunks where embedding is not null`);
    console.log(`embedded ${chunks} new chunk(s); ${total.rows[0].n} chunks in the table (${((Date.now() - started) / 1000).toFixed(1)}s)`);

    const scope = await resolveScope(pool, ["*", "phalanx"]);
    const ctx: ToolContext = {
      reader: pool,
      proposer: pool,
      scope,
      principal: { kind: "pat", tokenId: "check", label: "semantic-check", scope: ["*", "phalanx"], email: null, clientId: null },
      publicUrl: "http://localhost:3000",
      embeddings: provider,
      now: () => new Date(),
    };
    const lines: string[] = [];
    let passed = 0;
    for (const check of CHECKS) {
      const { result } = await searchConversations.run({ query: check.query, mode: "semantic", limit: 3 }, ctx);
      const results = result.results as Array<{ title: string; score: number; snippets: Array<{ text: string }> }>;
      const rank = results.findIndex((r) => r.title === check.expectTitle);
      const ok = rank >= 0;
      if (ok) passed++;
      lines.push(`| ${ok ? "pass" : "MISS"} | ${check.query} | ${check.expectTitle} | ${ok ? rank + 1 : "not in top 3"} | ${results.map((r) => r.title).join(" · ") || "(none)"} |`);
      console.log(`${ok ? "PASS" : "MISS"}  ${check.query}\n      expected: ${check.expectTitle}  got: ${results.map((r, i) => `${i + 1}. ${r.title}`).join("  ")}`);
    }
    const summary = `${passed}/${CHECKS.length} queries ranked the right recording in the top 3`;
    console.log(summary);

    const outDir = path.join(REPO_ROOT, "docs/mcp-verification");
    fs.mkdirSync(outDir, { recursive: true });
    const md = `# Semantic search quality check

Run with \`npm run mcp:semantic-check\` on ${new Date().toISOString().slice(0, 10)} against the seeded local database
(\`db/seed.sql\`), provider **${provider.name} ${provider.model}** (${provider.dimensions} dimensions), ${total.rows[0].n} chunks.

Each query paraphrases a passage that appears in exactly one seeded recording and shares no
keywords with it (the passages are listed under DISTINCTIVE in \`scripts/gen-seed.ts\`). The
check calls \`search_conversations\` in semantic mode with limit 3 and looks for the expected
recording in the results.

**Result: ${summary}.**

| Result | Query | Expected recording | Rank | Top 3 returned |
|---|---|---|---|---|
${lines.join("\n")}

${provider.name === "fake" ? "> The fake provider hashes words, so paraphrases without shared vocabulary cannot match: misses are expected here. Re-run with `EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=…` (or openai) for the real check; the table above is then overwritten.\n" : ""}
Passages targeted:

${CHECKS.map((c) => `- **${c.expectTitle}**: "${c.passage}"`).join("\n")}
`;
    const outFile = path.join(outDir, "semantic-check.md");
    fs.writeFileSync(outFile, md);
    console.log(`wrote ${path.relative(REPO_ROOT, outFile)}`);
    return provider.name === "fake" ? 0 : passed === CHECKS.length ? 0 : 1;
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
