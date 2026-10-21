import type pg from "pg";
import type { SearchResponse, SearchGroup } from "../../shared/types.ts";

export interface SearchFilters {
  q: string;
  page?: number;
  pageSize?: number;
  from?: string | null;
  to?: string | null;
  workspaceId?: string | null;
  partyId?: number | null;
}

// ts_headline wraps hits in these control characters; they cannot appear in
// transcript text, so the client can split on them without parsing HTML.
export const MARK_START = "\u0001";
export const MARK_END = "\u0002";
const HEADLINE_OPTS = `StartSel=${MARK_START}, StopSel=${MARK_END}, HighlightAll=true`;

export function splitMarked(s: string): Array<{ t: string; m: boolean }> {
  const parts: Array<{ t: string; m: boolean }> = [];
  const re = new RegExp(`${MARK_START}([^${MARK_END}]*)${MARK_END}`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push({ t: s.slice(last, m.index), m: false });
    parts.push({ t: m[1], m: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ t: s.slice(last), m: false });
  return parts;
}

/**
 * Grouped full-text search over transcript segments.
 *
 * One GIN probe (`tsv @@ websearch_to_tsquery`) finds every matching segment;
 * hits are grouped per recording, ranked by their best ts_rank, and paginated
 * by group. Only the three lines shown per group go through ts_headline.
 * websearch_to_tsquery gives us quoted phrases, OR and -exclusion for free.
 */
export async function searchSegments(pool: pg.Pool, f: SearchFilters): Promise<SearchResponse> {
  const started = Date.now();
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 50);
  const page = Math.max(f.page ?? 1, 1);
  const q = f.q.trim();
  if (!q) return { query: q, page, pageSize, groups: [], hasMore: false, tookMs: 0 };

  const params: unknown[] = [q];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.from) where.push(`i.occurred_at >= ${p(f.from)}::timestamptz`);
  if (f.to) where.push(`i.occurred_at < (${p(f.to)}::date + interval '1 day')`);
  if (f.workspaceId) where.push(`i.workspace_id = ${p(f.workspaceId)}`);
  if (f.partyId) {
    where.push(
      `exists (select 1 from interaction_participants ip where ip.interaction_id = i.id and ip.party_id = ${p(f.partyId)})`,
    );
  }
  const offset = p((page - 1) * pageSize);
  const limit = p(pageSize + 1);
  const opts = p(HEADLINE_OPTS);

  const sql = `
    with q as (select websearch_to_tsquery('english', $1) as tsq),
    grouped as (
      select s.interaction_id, count(*)::int as hit_count, max(ts_rank(s.tsv, q.tsq)) as best_rank
      from segments s
      cross join q
      join interactions i on i.id = s.interaction_id
      where s.tsv @@ q.tsq
      ${where.length ? "and " + where.join(" and ") : ""}
      group by s.interaction_id
    ),
    pg as (
      select g.*, i.title, i.occurred_at, i.source, i.workspace_id
      from grouped g
      join interactions i on i.id = g.interaction_id
      order by g.best_rank desc, i.occurred_at desc nulls last, g.interaction_id desc
      offset ${offset} limit ${limit}
    )
    select pg.interaction_id, pg.hit_count, pg.best_rank, pg.title, pg.occurred_at, pg.source, pg.workspace_id,
           (
             select json_agg(json_build_object(
                      'segmentId', h.id, 'startSec', h.start_sec, 'speaker', h.speaker,
                      'marked', ts_headline('english', h.text, q.tsq, ${opts}))
                    order by h.rank desc, h.start_sec)
             from (
               select s.id, s.start_sec, s.speaker, s.text, ts_rank(s.tsv, q.tsq) as rank
               from segments s
               where s.interaction_id = pg.interaction_id and s.tsv @@ q.tsq
               order by rank desc, s.start_sec
               limit 3
             ) h
           ) as lines
    from pg
    cross join q
    order by pg.best_rank desc, pg.occurred_at desc nulls last, pg.interaction_id desc`;

  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > pageSize;
  const groups: SearchGroup[] = rows.slice(0, pageSize).map((r) => ({
    interactionId: r.interaction_id,
    title: r.title,
    occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    source: r.source,
    workspaceId: r.workspace_id,
    hitCount: r.hit_count,
    lines: ((r.lines ?? []) as Array<{ segmentId: number; startSec: number; speaker: string | null; marked: string }>).map(
      (l) => ({
        segmentId: l.segmentId,
        startSec: l.startSec,
        speaker: l.speaker,
        parts: splitMarked(l.marked),
      }),
    ),
  }));
  return { query: q, page, pageSize, groups, hasMore, tookMs: Date.now() - started };
}

/** Find-in-transcript for one recording: returns matching segment ids in order. */
export async function searchWithinRecording(pool: pg.Pool, interactionId: number, q: string): Promise<number[]> {
  if (!q.trim()) return [];
  const { rows } = await pool.query(
    `select id from segments where interaction_id = $1 and tsv @@ websearch_to_tsquery('english', $2) order by idx`,
    [interactionId, q],
  );
  return rows.map((r) => r.id);
}
