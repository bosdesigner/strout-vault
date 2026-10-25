// What `vault status` / `vault why` answered, from Postgres: where the queue
// stands, what is failing, what has no off-site copy, and what was spent.

import type pg from "pg";
import { monthToDateSpend } from "./budget.ts";
import { EXTRACT_PROVIDER } from "./extract.ts";

export interface PipelineReport {
  queue: { queued: number; transcribing: number; failed: number; ready: number };
  downloads: { pending: number; failed: number };
  missingOffsite: { total: number; items: Array<{ id: number; title: string | null; occurredAt: string | null; source: string | null }> };
  spend: { month: string; groqUsd: number; anthropicUsd?: number; extractUsd?: number };
  /** Jarvis step 2. Absent when migration 0007 has not been applied yet. */
  extraction?: { unread: number; read: number; failed: number; openProposals: number };
  clips?: { toReview: number; approved: number; cut: number; renderFailed: number; unscouted: number };
}

export async function buildReport(pool: pg.Pool, now: Date): Promise<PipelineReport> {
  const [queue, downloads, missing, missingCount, groq, anthropic, extractUsd, extraction, clips, unscouted] = await Promise.all([
    pool.query(
      `select coalesce(pipeline_status, 'ready') as s, count(*)::int as n from interactions group by 1`,
    ),
    pool.query(`select status, count(*)::int as n from media where source = 'zoom' and role = 'original' and status in ('pending', 'failed') group by 1`),
    pool.query(
      `select i.id, i.title, i.occurred_at, i.source from interactions i
        where i.source is not null and not exists (
          select 1 from media m where m.interaction_id = i.id and m.storage in ('b2', 'r2', 's3_deep_archive')
            and m.kind in ('video', 'audio') and m.status in ('verified', 'verified_stable'))
        order by i.occurred_at desc nulls last limit 50`,
    ),
    pool.query(
      `select count(*)::int as n from interactions i
        where i.source is not null and not exists (
          select 1 from media m where m.interaction_id = i.id and m.storage in ('b2', 'r2', 's3_deep_archive')
            and m.kind in ('video', 'audio') and m.status in ('verified', 'verified_stable'))`,
    ),
    monthToDateSpend(pool, "groq", now),
    monthToDateSpend(pool, "anthropic", now),
    monthToDateSpend(pool, EXTRACT_PROVIDER, now),
    extractionCounts(pool),
    pool.query(
      `select status, count(*)::int as n, count(*) filter (where status = 'approved' and render_attempts >= 3)::int as exhausted from clip_candidates group by status`,
    ),
    pool.query(
      `select count(*)::int as n from interactions i join transcripts t on t.interaction_id = i.id where i.scouted_at is null and i.source in ('zoom', 'meet', 'upload')`,
    ),
  ]);
  const clipCounts = { toReview: 0, approved: 0, cut: 0, renderFailed: 0, unscouted: Number(unscouted.rows[0]?.n ?? 0) };
  for (const r of clips.rows as Array<{ status: string; n: number; exhausted: number }>) {
    if (r.status === "new") clipCounts.toReview += r.n;
    else if (r.status === "approved") {
      clipCounts.approved += r.n;
      clipCounts.renderFailed += r.exhausted;
    } else if (r.status === "cut") clipCounts.cut += r.n;
  }
  const q = { queued: 0, transcribing: 0, failed: 0, ready: 0 };
  for (const r of queue.rows as Array<{ s: string; n: number }>) {
    if (r.s === "queued" || r.s === "transcribing" || r.s === "failed") q[r.s] += r.n;
    else q.ready += r.n;
  }
  const d = { pending: 0, failed: 0 };
  for (const r of downloads.rows as Array<{ status: string; n: number }>) {
    if (r.status === "pending") d.pending += r.n;
    else d.failed += r.n;
  }
  return {
    queue: q,
    downloads: d,
    missingOffsite: {
      total: Number(missingCount.rows[0]?.n ?? 0),
      items: (missing.rows as Array<{ id: number; title: string | null; occurred_at: Date | null; source: string | null }>).map((r) => ({
        id: r.id,
        title: r.title,
        occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
        source: r.source,
      })),
    },
    spend: { month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`, groqUsd: groq, anthropicUsd: anthropic, extractUsd },
    ...(extraction ? { extraction } : {}),
    clips: clipCounts,
  };
}

/** Filed recordings read or waiting for extraction, and the review items it queued that are still open. */
async function extractionCounts(pool: pg.Pool): Promise<PipelineReport["extraction"] | null> {
  try {
    const { rows } = await pool.query(
      `select count(*) filter (where i.extracted_at is null)::int as unread,
              count(*) filter (where i.extracted_at is not null)::int as read,
              count(*) filter (where i.extracted_at is null and i.extract_error is not null and i.extract_error not like 'waiting:%')::int as failed,
              (select count(*)::int from review_queue where status = 'open' and proposal->>'source' = 'extract') as open_proposals
         from interactions i where i.workspace_id is not null and exists (select 1 from transcripts t where t.interaction_id = i.id)`,
    );
    return { unread: rows[0].unread, read: rows[0].read, failed: rows[0].failed, openProposals: rows[0].open_proposals };
  } catch (err) {
    if ((err as { code?: string }).code === "42703") return null; // undefined column: 0007 not applied yet
    throw err;
  }
}
