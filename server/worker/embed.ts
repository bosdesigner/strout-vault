// Embedding step: every transcribed recording that has no current embedding gets chunked
// and embedded (server/embeddings). Runs after transcription in the same hourly run, so a
// recording becomes semantically searchable within the hour it is transcribed. Failures are
// recorded on the recording (embed_error, embed_attempts) and retried on later runs; they
// never touch pipeline_status, so a provider outage cannot block transcription.
import type { WorkerContext } from "./context.ts";
import { outOfTime } from "./context.ts";
import { createEmbeddingProvider, type EmbeddingProvider } from "../embeddings/provider.ts";
import { embedInteraction, listEmbedCandidates, type EmbedCandidate } from "../embeddings/pipeline.ts";
import { tryAdvisoryLock } from "../db/locks.ts";

export interface EmbedSummary {
  configured: boolean;
  provider: string | null;
  model: string | null;
  candidates: number;
  done: number;
  chunks: number;
  tokens: number;
  failed: number;
  estimatedUsd: number;
  stoppedEarly?: string;
  errors: string[];
}

export async function processEmbeddings(ctx: WorkerContext, providerOverride?: EmbeddingProvider | null): Promise<EmbedSummary> {
  const summary: EmbedSummary = { configured: false, provider: null, model: null, candidates: 0, done: 0, chunks: 0, tokens: 0, failed: 0, estimatedUsd: 0, errors: [] };
  let provider: EmbeddingProvider | null;
  try {
    provider = providerOverride !== undefined ? providerOverride : createEmbeddingProvider(ctx.config, { fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, log: ctx.log });
  } catch (err) {
    summary.errors.push((err as Error).message);
    return summary;
  }
  const candidates = await listEmbedCandidates(ctx.pool, { limit: ctx.config.EMBED_MAX_PER_RUN });
  summary.candidates = candidates.length;
  if (!provider) {
    if (candidates.length) ctx.log(`embed: off (EMBEDDING_PROVIDER=off); ${candidates.length} recording(s) waiting`);
    return summary;
  }
  summary.configured = true;
  summary.provider = provider.name;
  summary.model = provider.model;
  if (!candidates.length) return summary;
  ctx.log(`embed: ${candidates.length} recording(s) waiting (${provider.name} ${provider.model})`);

  // The hourly run and the 10-minute messages run both embed; two runs rebuilding the same
  // recording's chunks at once could leave both sets behind, so only one embeds at a time.
  const lock = await tryAdvisoryLock(ctx.pool, "strout-vault-embed");
  try {
    if (!lock) {
      summary.stoppedEarly = "another embedding run is in progress";
      return summary;
    }
    await embedCandidates(ctx, provider, candidates, summary);
  } finally {
    await lock?.release();
  }
  summary.estimatedUsd = (summary.tokens / 1_000_000) * provider.usdPerMillionTokens;
  return summary;
}

async function embedCandidates(ctx: WorkerContext, provider: EmbeddingProvider, candidates: EmbedCandidate[], summary: EmbedSummary): Promise<void> {
  // A few recordings in flight at a time; each one is its own transaction.
  const queue = [...candidates];
  const workers = Array.from({ length: Math.max(1, ctx.config.EMBED_CONCURRENCY) }, async () => {
    while (queue.length) {
      if (outOfTime(ctx)) {
        summary.stoppedEarly = "time budget";
        return;
      }
      const c = queue.shift()!;
      const label = c.title?.trim() || `#${c.id}`;
      try {
        const out = await embedInteraction(ctx.pool, provider, c.id);
        if (out.skipped) continue;
        summary.done++;
        summary.chunks += out.chunks.length;
        summary.tokens += out.tokens;
        ctx.log(`embed:   ${label}: ${out.chunks.length} chunk(s), ~${out.tokens} tokens`);
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        summary.failed++;
        summary.errors.push(`${label}: ${msg}`);
        ctx.log(`embed:   ${label}: FAILED ${msg}`);
        // A key or quota problem fails every item the same way: stop after the first few.
        if (summary.failed >= 3 && summary.done === 0) {
          summary.stoppedEarly = "repeated provider errors";
          queue.length = 0;
        }
      }
    }
  });
  await Promise.all(workers);
}
