// Chunk + embed one recording, idempotently: the recording's chunks are deleted and
// rebuilt inside one transaction, so a crash never leaves half a set behind and a re-run
// is harmless. Bookkeeping lives on interactions (embedded_at, embed_model, embed_error,
// embed_attempts), the same way scouting records itself.
import type pg from "pg";
import { buildChunks, type BuiltChunk, type ChunkOptions } from "./chunker.ts";
import { toVectorLiteral, type EmbeddingProvider } from "./provider.ts";

export interface EmbedPlan {
  interactionId: number;
  chunks: BuiltChunk[];
  tokens: number;
}

export interface EmbedOutcome extends EmbedPlan {
  skipped?: "no-segments";
}

export const MAX_EMBED_ATTEMPTS = 5;

/** Loads the recording's segments and runs the chunker; writes nothing. */
export async function planInteraction(pool: pg.Pool | pg.PoolClient, interactionId: number, options?: ChunkOptions): Promise<EmbedPlan> {
  const { rows } = await pool.query(
    `select idx, start_sec, end_sec, speaker, text from segments where interaction_id = $1 order by idx`,
    [interactionId],
  );
  const chunks = buildChunks(
    rows.map((r) => ({ idx: r.idx, startSec: Number(r.start_sec), endSec: Number(r.end_sec), speaker: r.speaker, text: r.text })),
    options,
  );
  return { interactionId, chunks, tokens: chunks.reduce((n, c) => n + c.tokens, 0) };
}

/** Chunks, embeds and stores one recording. Records a failure on the row and rethrows. */
export async function embedInteraction(pool: pg.Pool, provider: EmbeddingProvider, interactionId: number, options?: ChunkOptions): Promise<EmbedOutcome> {
  const plan = await planInteraction(pool, interactionId, options);
  if (!plan.chunks.length) {
    await pool.query(
      `update interactions set embed_error = 'no transcript segments', embed_attempts = embed_attempts + 1 where id = $1`,
      [interactionId],
    );
    return { ...plan, skipped: "no-segments" };
  }
  try {
    const vectors = await provider.embed(
      plan.chunks.map((c) => c.text),
      "document",
    );
    await writeChunks(pool, interactionId, plan.chunks, vectors, provider.model);
    return plan;
  } catch (err) {
    await markEmbedFailure(pool, interactionId, (err as Error).message);
    throw err;
  }
}

export async function markEmbedFailure(pool: pg.Pool, interactionId: number, message: string): Promise<void> {
  await pool.query(`update interactions set embed_error = $2, embed_attempts = embed_attempts + 1 where id = $1`, [interactionId, message.slice(0, 500)]);
}

/** One transaction: drop the old chunks, insert the new ones, stamp the recording. */
export async function writeChunks(pool: pg.Pool, interactionId: number, chunks: BuiltChunk[], vectors: number[][], model: string): Promise<void> {
  if (vectors.length !== chunks.length) throw new Error(`got ${vectors.length} embeddings for ${chunks.length} chunks`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from chunks where interaction_id = $1`, [interactionId]);
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const values: string[] = [];
      const params: unknown[] = [];
      slice.forEach((c, j) => {
        params.push(interactionId, c.seq, c.startSec, c.endSec, c.text, toVectorLiteral(vectors[i + j]));
        const b = params.length - 6;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::vector)`);
      });
      await client.query(`insert into chunks (interaction_id, seq, start_sec, end_sec, text, embedding) values ${values.join(", ")}`, params);
    }
    await client.query(
      `update interactions set embedded_at = now(), embed_model = $2, embed_error = null, embed_attempts = embed_attempts + 1 where id = $1`,
      [interactionId, model],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface CandidateFilters {
  workspaceId?: string | null;
  limit?: number;
  /** Include recordings whose attempts are exhausted (the backfill's --retry-failed). */
  retryFailed?: boolean;
}

export interface EmbedCandidate {
  id: number;
  title: string | null;
  workspace_id: string | null;
  occurred_at: Date | null;
  segment_count: number;
  embed_attempts: number;
}

/**
 * Recordings that need (re)embedding: they have transcript segments and were never embedded,
 * or the pipeline rewrote them after the last embedding. Newest first, so recent
 * conversations become searchable first.
 */
export async function listEmbedCandidates(pool: pg.Pool, f: CandidateFilters = {}): Promise<EmbedCandidate[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [
    `exists (select 1 from segments s where s.interaction_id = i.id)`,
    `(i.embedded_at is null or i.embedded_at < coalesce(i.pipeline_updated_at, i.embedded_at))`,
    `(i.pipeline_status is null or i.pipeline_status = 'ready')`,
  ];
  // The worker runs hourly, so a failed recording is retried at most once an hour until its
  // attempts run out; the backfill's --retry-failed resets nothing but ignores the ceiling.
  if (!f.retryFailed) where.push(`i.embed_attempts < ${p(MAX_EMBED_ATTEMPTS)}`);
  if (f.workspaceId) where.push(`i.workspace_id = ${p(f.workspaceId)}`);
  const limit = f.limit ? `limit ${p(f.limit)}` : "";
  const { rows } = await pool.query(
    `select i.id, i.title, i.workspace_id, i.occurred_at, i.embed_attempts,
            (select count(*)::int from segments s where s.interaction_id = i.id) as segment_count
       from interactions i
      where ${where.join(" and ")}
      order by i.occurred_at desc nulls last, i.id desc ${limit}`,
    params,
  );
  return rows as EmbedCandidate[];
}

export interface EmbeddingStatus {
  /** Recordings with chunks and a current embedding. */
  embedded: number;
  /** Recordings with transcript segments that still wait for their first embedding. */
  pending: number;
  /** Recordings whose last attempt failed (retried up to MAX_EMBED_ATTEMPTS, then shown here until retried by hand). */
  failed: number;
  /** Recordings with no transcript segments at all; nothing to embed yet. */
  noTranscript: number;
  chunks: number;
  lastEmbeddedAt: string | null;
  models: Array<{ model: string; recordings: number }>;
}

export async function embeddingStatus(pool: pg.Pool): Promise<EmbeddingStatus> {
  const [counts, chunks, models] = await Promise.all([
    pool.query(
      `select
         count(*) filter (where has_segments and embedded_at is not null and embed_error is null)::int as embedded,
         count(*) filter (where has_segments and embedded_at is null and embed_error is null)::int as pending,
         count(*) filter (where has_segments and embed_error is not null)::int as failed,
         count(*) filter (where not has_segments)::int as no_transcript,
         max(embedded_at) as last_embedded_at
       from (select i.*, exists (select 1 from segments s where s.interaction_id = i.id) as has_segments from interactions i) x`,
    ),
    pool.query(`select count(*)::int as n from chunks where embedding is not null`),
    pool.query(`select embed_model as model, count(*)::int as n from interactions where embed_model is not null group by 1 order by 2 desc`),
  ]);
  const c = counts.rows[0];
  return {
    embedded: c.embedded,
    pending: c.pending,
    failed: c.failed,
    noTranscript: c.no_transcript,
    chunks: chunks.rows[0].n,
    lastEmbeddedAt: c.last_embedded_at ? new Date(c.last_embedded_at).toISOString() : null,
    models: models.rows.map((r) => ({ model: r.model, recordings: r.n })),
  };
}
