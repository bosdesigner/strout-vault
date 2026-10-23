// What `vault status` / `vault why` answered, from Postgres: where the queue
// stands, what is failing, what has no off-site copy, and what was spent.

import type pg from "pg";
import { monthToDateSpend } from "./budget.ts";

export interface PipelineReport {
  queue: { queued: number; transcribing: number; failed: number; ready: number };
  downloads: { pending: number; failed: number };
  missingOffsite: { total: number; items: Array<{ id: number; title: string | null; occurredAt: string | null; source: string | null }> };
  spend: { month: string; groqUsd: number };
}

export async function buildReport(pool: pg.Pool, now: Date): Promise<PipelineReport> {
  const [queue, downloads, missing, missingCount, groq] = await Promise.all([
    pool.query(
      `select coalesce(pipeline_status, 'ready') as s, count(*)::int as n from interactions where source is not null group by 1`,
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
  ]);
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
    spend: { month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`, groqUsd: groq },
  };
}
