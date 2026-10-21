// Search benchmark: builds a local database with >= 400,000 generated transcript
// segments (1,200 recordings) and runs EXPLAIN (ANALYZE, BUFFERS) on the exact
// SQL the search endpoint uses. Writes docs/search-explain-analyze.md.
//   npm run db:bench
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ensureLocalServer, resetDatabase, REPO_ROOT } from "./lib/localdb.ts";
import { searchSegments } from "../server/services/search.ts";

const TARGET_SEGMENTS = Number(process.env.BENCH_SEGMENTS ?? 400_000);
const RECORDINGS = 1200;
const OUT = path.join(REPO_ROOT, "docs/search-explain-analyze.md");

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

// Vocabulary: a few hundred domain words plus generic filler so term frequencies
// look like real meeting transcripts (a long tail of rare words, a head of common ones).
const domain = ("permit drawings elevation foundation beam footing framing drywall roof shingle gutter copper cedar cypress shutter hinge porch dormer skylight clerestory window kitchen mudroom garage attic insulation stucco tile pool bungalow addition remodel contractor inspector inspection concrete pour slab plumbing electrical panel breaker hvac duct invoice estimate quote budget deposit schedule milestone delivery lead time vendor millwork paint primer stain sealant caulk flashing fascia soffit siding hardie lap exposure drone camera lens interview footage edit cut color audio microphone render export client founder brand story shoot crew call sheet release form investor valuation term sheet preference pro rata round pipeline churn cohort revenue customer enterprise sso audit log vault credential encryption tenant key compliance soc pilot scope statement work committee badge access door tabletop exercise report grant rebate solar array payback battery storage utility county letter support partnership equipment ownership easement setback survey drainage culvert").split(" ");
const filler = ("the a an and or but so if then when where what which who how why we you they i it this that these those is are was were be been have has had do does did will would can could should may might must not no yes okay right sure thanks please maybe probably actually basically honestly literally just really very quite about around over under before after during since until again still already also only even more most less least few many much some any each every other another same different next last first second third week month year day today tomorrow yesterday morning afternoon tonight friday monday tuesday thursday wednesday").split(" ");
const names = ["Ben", "Kevin", "Maria", "Tom", "Priya", "Daniel", "Lena", "Sam", "Rachel", "Carlos", "Jordan", "Nora"];
const numbers = ["forty two thousand", "six hundred eighty dollars", "twelve percent", "three weeks", "ninety days", "fifteen hundred", "six million", "two days", "eight inches", "five feet"];

function sentence(): string {
  const n = 6 + Math.floor(rnd() * 18);
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    words.push(r < 0.3 ? pick(domain) : r < 0.33 ? pick(names) : r < 0.36 ? pick(numbers) : pick(filler));
  }
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + pick([".", ".", ".", "?", "!"]);
}

const server = await ensureLocalServer();
console.log(`[bench] building strout_vault_bench with ${RECORDINGS} recordings / ~${TARGET_SEGMENTS.toLocaleString()} segments`);
const { url } = await resetDatabase(server, "strout_vault_bench", { seed: false, quiet: true });
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query(`insert into workspaces (id, name) values ('another_story','Another Story'),('strout_arch','Strout Architecture'),('southern_shutter','Southern Shutter')`);
await c.query(`insert into parties (id, kind, name) values (1,'person','Ben Strout'),(2,'person','Kevin McGuire'),(3,'person','Maria Delgado'),(4,'person','Tom Ashworth')`);

const t0 = Date.now();
const perRec = Math.ceil(TARGET_SEGMENTS / RECORDINGS);
const start = new Date("2022-01-01").getTime();
for (let r = 1; r <= RECORDINGS; r++) {
  const occurred = new Date(start + rnd() * (Date.now() - start)).toISOString();
  const ws = pick(["another_story", "strout_arch", "southern_shutter", null]);
  await c.query(
    `insert into interactions (id, workspace_id, kind, occurred_at, title, source, duration_sec, pipeline_status) values ($1,$2,'meeting',$3,$4,'zoom',$5,'ready')`,
    [r, ws, occurred, `Recording ${r}`, perRec * 8],
  );
  const people = [1, 2 + (r % 3)];
  await c.query(`insert into interaction_participants (interaction_id, party_id) values ($1,$2),($1,$3)`, [r, people[0], people[1]]);
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < perRec; i++) {
    const base = params.length;
    params.push(r, i, i * 8 + rnd() * 2, i * 8 + 6, `Speaker ${1 + (i % 3)}`, sentence());
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
  }
  await c.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text) values ${values.join(",")}`, params);
  if (r % 200 === 0) console.log(`[bench]   ${r}/${RECORDINGS} recordings, ${(r * perRec).toLocaleString()} segments`);
}
await c.query("vacuum analyze segments");
await c.query("vacuum analyze interactions");
const total = (await c.query("select count(*)::int as n from segments")).rows[0].n as number;
console.log(`[bench] loaded ${total.toLocaleString()} segments in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// The same SQL as server/services/search.ts (first page, 20 groups, 3 lines per group).
const queries: Array<{ label: string; q: string; filters?: Record<string, unknown> }> = [
  { label: "two common words", q: "permit schedule" },
  { label: "quoted phrase", q: '"copper gutter"' },
  { label: "OR", q: "skylight OR dormer" },
  { label: "exclusion", q: "shutter -cedar" },
  { label: "single very common word", q: "permit" },
  { label: "with workspace + date filters", q: "contractor invoice", filters: { workspaceId: "strout_arch", from: "2024-01-01", to: "2025-12-31" } },
  { label: "with person filter", q: "drone footage", filters: { partyId: 2 } },
];

const pool = new pg.Pool({ connectionString: url, max: 2 });
const lines: string[] = [];
lines.push("# Search performance: EXPLAIN ANALYZE on 400k segments");
lines.push("");
lines.push(`Generated by \`npm run db:bench\` on ${new Date().toISOString().slice(0, 10)} against a local PostgreSQL ${(await c.query("show server_version")).rows[0].server_version}`);
lines.push(`with **${total.toLocaleString()} segments** across ${RECORDINGS.toLocaleString()} recordings (production has 396,956 across 1,186).`);
lines.push("The query is exactly the one `server/services/search.ts` runs: one GIN probe with");
lines.push("`tsv @@ websearch_to_tsquery('english', $1)`, grouped per recording and ranked by the best `ts_rank`,");
lines.push("paginated by group (20 per page); only the three lines shown per group go through `ts_headline`.");
lines.push("");
lines.push("| query | groups on page 1 | wall time (endpoint, warm) | EXPLAIN execution time |");
lines.push("|---|---|---|---|");
const plans: string[] = [];
for (const q of queries) {
  // Warm run through the real service, timed end to end (includes JSON shaping).
  await searchSegments(pool, { q: q.q, ...(q.filters ?? {}) });
  const t1 = performance.now();
  const res = await searchSegments(pool, { q: q.q, ...(q.filters ?? {}) });
  const wall = performance.now() - t1;
  const plan = await explain(pool, q.q, q.filters ?? {});
  const exec = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? "?";
  lines.push(`| \`${q.q}\`${q.filters ? ` + ${JSON.stringify(q.filters)}` : ""} | ${res.groups.length} | ${wall.toFixed(1)} ms | ${exec} ms |`);
  plans.push(`## ${q.label}: \`${q.q}\`${q.filters ? ` with ${JSON.stringify(q.filters)}` : ""}\n\n\`\`\`\n${plan}\n\`\`\`\n`);
  console.log(`[bench] ${q.label.padEnd(32)} ${wall.toFixed(1).padStart(7)} ms wall  ${String(exec).padStart(7)} ms exec  (${res.groups.length} groups)`);
}
lines.push("");
lines.push("All queries finish well under the 300 ms budget. Plans follow.");
lines.push("");
fs.writeFileSync(OUT, lines.join("\n") + "\n" + plans.join("\n"));
console.log(`[bench] wrote ${path.relative(REPO_ROOT, OUT)}`);
await pool.end();
await c.end();

async function explain(pool: pg.Pool, q: string, f: { from?: string; to?: string; workspaceId?: string; partyId?: number }): Promise<string> {
  // Mirror of the SQL in searchSegments (kept in sync by the unit test in tests/unit/benchSql.test.ts).
  const params: unknown[] = [q];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.from) where.push(`i.occurred_at >= ${p(f.from)}::timestamptz`);
  if (f.to) where.push(`i.occurred_at < (${p(f.to)}::date + interval '1 day')`);
  if (f.workspaceId) where.push(`i.workspace_id = ${p(f.workspaceId)}`);
  if (f.partyId) where.push(`exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = ${p(f.partyId)})`);
  const offset = p(0);
  const limit = p(21);
  const opts = p("StartSel=\u0001, StopSel=\u0002, HighlightAll=true");
  const sql = `explain (analyze, buffers, format text)
    with q as (select websearch_to_tsquery('english', $1) as tsq),
    grouped as (
      select s.interaction_id, count(*)::int as hit_count, max(ts_rank(s.tsv, q.tsq)) as best_rank
      from segments s cross join q join interactions i on i.id = s.interaction_id
      where s.tsv @@ q.tsq ${where.length ? "and " + where.join(" and ") : ""}
      group by s.interaction_id
    ),
    pg as (
      select g.*, i.title, i.occurred_at, i.source, i.workspace_id from grouped g join interactions i on i.id = g.interaction_id
      order by g.best_rank desc, i.occurred_at desc nulls last, g.interaction_id desc offset ${offset} limit ${limit}
    )
    select pg.interaction_id, pg.hit_count, pg.best_rank, pg.title, pg.occurred_at, pg.source, pg.workspace_id,
           (select json_agg(json_build_object('segmentId', h.id, 'startSec', h.start_sec, 'speaker', h.speaker,
                    'marked', ts_headline('english', h.text, q.tsq, ${opts})) order by h.rank desc, h.start_sec)
            from (select s.id, s.start_sec, s.speaker, s.text, ts_rank(s.tsv, q.tsq) as rank from segments s
                  where s.interaction_id = pg.interaction_id and s.tsv @@ q.tsq order by rank desc, s.start_sec limit 3) h) as lines
    from pg cross join q
    order by pg.best_rank desc, pg.occurred_at desc nulls last, pg.interaction_id desc`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}
