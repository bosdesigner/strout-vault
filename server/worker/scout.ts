// Clip scouting: Claude reads each new transcript the way a short-form editor
// would and files candidates into clip_candidates. Ported from meeting-vault's
// scout.py; a human still approves every candidate before anything is cut.
//
// Transcript text leaves the vault for this and it costs money, so nothing is
// sent unless ANTHROPIC_API_KEY is set and the month's spend stays under
// SCOUT_MONTHLY_BUDGET_USD (budget.ts). Nothing here deletes anything.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { WorkerContext } from "./context.ts";
import { outOfTime } from "./context.ts";
import { checkBudget, recordSpend } from "./budget.ts";

/** $ per 1M tokens, Anthropic list prices (cached 2026-10). Verify at platform.claude.com/pricing. */
export const MODEL_PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
export const DEFAULT_SCOUT_MODEL = "claude-opus-5-5";

export function priceFor(model: string) {
  return MODEL_PRICES[model] ?? MODEL_PRICES[DEFAULT_SCOUT_MODEL];
}

/** A transcript hour is roughly 9k words ~ 12k tokens; chunks keep requests small and let one bad chunk fail alone. */
export const CHUNK_SECONDS = 25 * 60;
const PROMPT_OVERHEAD_TOKENS = 600;

export const SYSTEM_PROMPT = `You are a short-form video editor reviewing meeting transcripts for moments that would work as TikTok / Reels / Shorts clips. The speaker is a business founder (a residential builder and architect); the audience is homeowners, entrepreneurs and small-business owners.

You are looking for 15-60 second self-contained moments with at least one of:
- a hook: a bold claim, a surprising number, a contrarian take
- a complete micro-story with a turn or punchline
- genuinely useful advice stated crisply
- real emotion: excitement, frustration, disbelief

Rules:
- The moment must stand alone with zero context from the rest of the meeting.
- Never pick moments naming a client, a person other than the speaker, confidential pricing, or anything a client would not want public. When in doubt, skip it.
- Most transcript chunks contain NOTHING worth clipping. An empty list is a good answer. Only score 8+ if you would genuinely stop scrolling.
- Timestamps are the [HH:MM:SS] stamps in the transcript, converted to seconds from the start of the recording. start_sec and end_sec must fall inside this chunk.
- "hook" is the opening line, verbatim from the transcript.`;

export const CandidateSchema = z.object({
  start_sec: z.number(),
  end_sec: z.number(),
  score: z.number().int().min(1).max(10),
  hook: z.string(),
  why: z.string(),
  platforms: z.array(z.enum(["tiktok", "reels", "shorts", "linkedin"])),
});
export const ScoutOutputSchema = z.object({ candidates: z.array(CandidateSchema) });
export type ScoutOutput = z.infer<typeof ScoutOutputSchema>;

export interface SegmentRow {
  start_sec: number;
  end_sec: number;
  speaker: string | null;
  text: string;
}

export interface Candidate {
  startSec: number;
  endSec: number;
  score: number;
  hook: string;
  why: string;
  platforms: string;
}

export interface ScoutSummary {
  configured: boolean;
  candidatesRecordings: number;
  scanned: number;
  found: number;
  waitingOnBudget: number;
  failed: number;
  spentUsd: number;
  stoppedEarly?: string;
  errors: string[];
}

export class ScoutError extends Error {}

/** Split a recording's segments into ~25-minute windows. */
export function chunkSegments(segments: SegmentRow[], chunkSeconds = CHUNK_SECONDS): SegmentRow[][] {
  const out: SegmentRow[][] = [];
  let cur: SegmentRow[] = [];
  let curStart: number | null = null;
  for (const seg of segments) {
    if (curStart === null) curStart = seg.start_sec || 0;
    cur.push(seg);
    if ((seg.end_sec || 0) - curStart >= chunkSeconds) {
      out.push(cur);
      cur = [];
      curStart = null;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function chunkText(chunk: SegmentRow[]): string {
  return chunk.map((s) => `[${stamp(s.start_sec || 0)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
}

function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Keep only candidates that make sense: inside the chunk's time range (the model
 * occasionally invents timestamps, and a clip cut at the wrong offset is worse
 * than a dropped candidate), 5-120 s long, score 1-10.
 */
export function filterCandidates(out: ScoutOutput | null | undefined, chunkStart: number, chunkEnd: number): Candidate[] {
  const result: Candidate[] = [];
  for (const c of out?.candidates ?? []) {
    const s = Number(c.start_sec);
    const e = Number(c.end_sec);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (!(chunkStart - 5 <= s && s < e && e <= chunkEnd + 30)) continue;
    if (e - s < 5 || e - s > 120) continue;
    const score = Math.round(Number(c.score));
    if (!(score >= 1 && score <= 10)) continue;
    result.push({ startSec: s, endSec: e, score, hook: String(c.hook ?? "").slice(0, 300), why: String(c.why ?? "").slice(0, 300), platforms: (c.platforms ?? []).join(",").slice(0, 100) });
  }
  return result;
}

/** Rough price of scouting a transcript of `words` words across `calls` chunks, for the budget pre-check. */
export function estimateScoutCostUsd(words: number, calls: number, model: string): number {
  const tokens = Math.round(words * 1.35) + Math.max(1, calls) * PROMPT_OVERHEAD_TOKENS;
  const p = priceFor(model);
  return (tokens * p.in + tokens * 0.02 * p.out) / 1_000_000;
}

/** Actual cost from a response's usage, priced by the model that served it. */
export function usageCostUsd(usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined, model: string): number {
  const p = priceFor(model);
  const u = usage ?? {};
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1_000_000;
}

export function scoutConfigured(ctx: WorkerContext): boolean {
  return !!ctx.config.ANTHROPIC_API_KEY && ctx.config.SCOUT_MONTHLY_BUDGET_USD > 0;
}

function makeClient(ctx: WorkerContext): Anthropic {
  return new Anthropic({
    apiKey: ctx.config.ANTHROPIC_API_KEY,
    baseURL: ctx.config.ANTHROPIC_API_URL ?? undefined,
    fetch: ctx.fetchImpl as typeof fetch,
    maxRetries: 3,
    timeout: 10 * 60 * 1000,
  });
}

interface ScoutCandidateRow {
  id: number;
  title: string | null;
  word_count: number | null;
  span_sec: number | null;
}

export async function processScouting(ctx: WorkerContext): Promise<ScoutSummary> {
  const summary: ScoutSummary = { configured: scoutConfigured(ctx), candidatesRecordings: 0, scanned: 0, found: 0, waitingOnBudget: 0, failed: 0, spentUsd: 0, errors: [] };
  if (!ctx.config.ANTHROPIC_API_KEY) {
    ctx.log("scout: skipped (ANTHROPIC_API_KEY not set)");
    return summary;
  }
  const sources = ctx.config.SCOUT_SOURCES.split(",").map((s) => s.trim()).filter(Boolean);
  const { rows } = await ctx.pool.query<ScoutCandidateRow>(
    `select i.id, i.title, t.word_count,
            (select max(s.end_sec) - min(s.start_sec) from segments s where s.interaction_id = i.id) as span_sec
       from interactions i join transcripts t on t.interaction_id = i.id
      where i.scouted_at is null and i.source = any($1::text[])
        and exists (select 1 from segments s where s.interaction_id = i.id)
      order by i.occurred_at desc nulls last, i.id desc
      limit $2`,
    [sources, ctx.config.SCOUT_MAX_PER_RUN],
  );
  summary.candidatesRecordings = rows.length;
  if (!rows.length) return summary;
  if (!summary.configured) {
    ctx.log(`scout: ${rows.length} recording(s) waiting; scouting is off until SCOUT_MONTHLY_BUDGET_USD is set`);
    return summary;
  }
  ctx.log(`scout: ${rows.length} recording(s) to read (model ${ctx.config.SCOUT_MODEL}, effort ${ctx.config.SCOUT_EFFORT})`);
  const client = makeClient(ctx);
  const model = ctx.config.SCOUT_MODEL;
  for (const rec of rows) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const label = rec.title?.trim() || `#${rec.id}`;
    const calls = Math.max(1, Math.floor((rec.span_sec ?? 0) / CHUNK_SECONDS) + 1);
    const estimate = estimateScoutCostUsd(rec.word_count ?? 0, calls, model);
    const check = await checkBudget(ctx.pool, "anthropic", ctx.config.SCOUT_MONTHLY_BUDGET_USD, estimate, ctx.now());
    if (!check.allowed) {
      summary.waitingOnBudget++;
      summary.stoppedEarly = "scout budget";
      await ctx.pool.query(`update interactions set scout_error = $2 where id = $1`, [rec.id, `waiting: ${check.reason}`]);
      ctx.log(`scout:   ${label}: ${check.reason}`);
      break; // everything after this costs at least as much; try again next month or after a raise
    }
    try {
      const r = await scoutRecording(ctx, client, model, rec.id);
      summary.scanned++;
      summary.found += r.found;
      summary.spentUsd += r.costUsd;
      ctx.log(`scout:   ${label}: ${r.found} candidate(s) in ${r.chunks} chunk(s) ($${r.costUsd.toFixed(3)})`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      summary.failed++;
      summary.errors.push(`${label}: ${msg}`);
      await ctx.pool.query(`update interactions set scout_error = $2 where id = $1`, [rec.id, msg]);
      ctx.log(`scout:   ${label}: FAILED ${msg}`);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        summary.stoppedEarly = "api key refused";
        break; // would fail for every recording
      }
    }
  }
  return summary;
}

/** Scan one recording's transcript chunk by chunk. Idempotent via interactions.scouted_at. */
export async function scoutRecording(ctx: WorkerContext, client: Anthropic, model: string, interactionId: number): Promise<{ found: number; chunks: number; costUsd: number }> {
  const { rows: segments } = await ctx.pool.query<SegmentRow>(`select start_sec, end_sec, speaker, text from segments where interaction_id = $1 order by idx`, [interactionId]);
  const chunks = chunkSegments(segments);
  const found: Candidate[] = [];
  let costUsd = 0;
  for (const chunk of chunks) {
    const chunkStart = chunk[0].start_sec || 0;
    const chunkEnd = chunk[chunk.length - 1].end_sec || 0;
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: chunkText(chunk) }],
      output_config: { effort: ctx.config.SCOUT_EFFORT, format: zodOutputFormat(ScoutOutputSchema) },
    });
    costUsd += usageCostUsd(response.usage, response.model || model);
    if (response.stop_reason === "refusal") continue; // the chunk yields nothing; the rest of the recording still runs
    if (response.stop_reason === "max_tokens") throw new ScoutError("the reply was cut off (max_tokens); the chunk may be too long");
    found.push(...filterCandidates(response.parsed_output, chunkStart, chunkEnd));
  }

  const db = await ctx.pool.connect();
  try {
    await db.query("begin");
    let inserted = 0;
    for (const c of found) {
      // The model often finds the same moment again on a re-scan: one already approved, rejected or cut must not come back.
      const dup = await db.query(
        `select 1 from clip_candidates where interaction_id = $1 and abs(start_sec - $2) <= 1.5 and abs(end_sec - $3) <= 1.5 limit 1`,
        [interactionId, c.startSec, c.endSec],
      );
      if (dup.rowCount) continue;
      await db.query(
        `insert into clip_candidates (interaction_id, start_sec, end_sec, score, hook, why, platforms, status, model) values ($1, $2, $3, $4, $5, $6, $7, 'new', $8)`,
        [interactionId, c.startSec, c.endSec, c.score, c.hook, c.why, c.platforms, model],
      );
      inserted++;
    }
    await db.query(`update interactions set scouted_at = now(), scout_error = null, updated_at = now() where id = $1`, [interactionId]);
    await db.query("commit");
    if (costUsd > 0) await recordSpend(ctx.pool, { provider: "anthropic", model, interactionId, unitsSec: null, usd: costUsd, note: `${chunks.length} chunk(s), ${inserted} candidate(s)` });
    return { found: inserted, chunks: chunks.length, costUsd };
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
