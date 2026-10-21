import type pg from "pg";
import type { LibraryCard, LibraryPage } from "../../shared/types.ts";
import { firstMeaningfulLine } from "../../shared/text.ts";

export interface LibraryFilters {
  from?: string | null; // ISO date (inclusive)
  to?: string | null; // ISO date (inclusive, whole day)
  sources?: string[] | null;
  workspaceId?: string | null;
  partyId?: number | null;
  hasVideo?: boolean | null;
  limit?: number;
  cursor?: string | null;
}

interface Cursor {
  o: string | null;
  id: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (typeof c.id !== "number") return null;
    if (c.o !== null && typeof c.o !== "string") return null;
    return c;
  } catch {
    return null;
  }
}

export async function listLibrary(
  pool: pg.Pool,
  filters: LibraryFilters,
  servable: string[],
): Promise<LibraryPage> {
  const limit = Math.min(Math.max(filters.limit ?? 24, 1), 100);
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (filters.from) where.push(`i.occurred_at >= ${p(filters.from)}::timestamptz`);
  if (filters.to) where.push(`i.occurred_at < (${p(filters.to)}::date + interval '1 day')`);
  if (filters.sources?.length) where.push(`i.source = any(${p(filters.sources)}::text[])`);
  if (filters.workspaceId) where.push(`i.workspace_id = ${p(filters.workspaceId)}`);
  if (filters.partyId) {
    where.push(
      `exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = ${p(filters.partyId)})`,
    );
  }
  const hasVideoSql = `exists (
      select 1 from media m
      where m.interaction_id = i.id
        and m.storage = any(${p(servable)}::text[])
        and m.storage_key !~ '^/'
        and coalesce(m.kind, 'video') in ('video', 'audio')
        and coalesce(m.status, '') not in ('failed', 'missing', 'deleted_local', 'pending')
    )`;
  if (filters.hasVideo === true) where.push(hasVideoSql);
  if (filters.hasVideo === false) where.push(`not ${hasVideoSql}`);

  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    if (cursor.o === null) {
      where.push(`i.occurred_at is null and i.id < ${p(cursor.id)}`);
    } else {
      const o = p(cursor.o);
      where.push(`(i.occurred_at < ${o}::timestamptz or (i.occurred_at = ${o}::timestamptz and i.id < ${p(cursor.id)}) or i.occurred_at is null)`);
    }
  }

  const sql = `
    select i.id, i.title, i.occurred_at, i.duration_sec, i.source, i.workspace_id,
           i.pipeline_status, i.tags,
           left(i.summary, 1500) as summary_head,
           left(i.transcript, 3000) as transcript_head,
           ${hasVideoSql} as has_video,
           coalesce((
             select json_agg(json_build_object('id', x.id, 'name', x.name) order by x.name)
             from (
               select pa.id, pa.name
               from interaction_participants ip
               join parties pa on pa.id = ip.party_id
               where ip.interaction_id = i.id
               order by pa.name
               limit 3
             ) x
           ), '[]'::json) as participants,
           (select count(*)::int from interaction_participants ip where ip.interaction_id = i.id) as participant_count
    from interactions i
    ${where.length ? "where " + where.join(" and ") : ""}
    order by i.occurred_at desc nulls last, i.id desc
    limit ${limit + 1}`;

  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: LibraryCard[] = page.map((r) => ({
    id: r.id,
    title: r.title,
    occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    durationSec: r.duration_sec,
    source: r.source,
    workspaceId: r.workspace_id,
    pipelineStatus: r.pipeline_status,
    preview: firstMeaningfulLine(r.summary_head) ?? firstMeaningfulLine(r.transcript_head),
    participants: r.participants ?? [],
    participantCount: r.participant_count ?? 0,
    hasVideo: !!r.has_video,
    tags: r.tags ?? [],
  }));
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ o: last.occurred_at ? new Date(last.occurred_at).toISOString() : null, id: last.id }) : null;
  return { items, nextCursor };
}

export async function pipelineStatuses(pool: pg.Pool, ids: number[]) {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `select id, pipeline_status, pipeline_error, duration_sec, title from interactions where id = any($1::bigint[])`,
    [ids],
  );
  return rows.map((r) => ({
    id: r.id as number,
    pipelineStatus: r.pipeline_status as string | null,
    pipelineError: r.pipeline_error as string | null,
    durationSec: r.duration_sec as number | null,
    title: r.title as string | null,
  }));
}
