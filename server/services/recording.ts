import type pg from "pg";
import type { StorageDriver } from "../storage/types.ts";
import type { RecordingDetail, TranscriptLine, RoleChip } from "../../shared/types.ts";
import { pickVideoSource, type PlayableCandidate } from "./videoSource.ts";

const PRESIGN_TTL_SEC = 6 * 3600;

export async function getRecording(pool: pg.Pool, storage: StorageDriver, id: number): Promise<RecordingDetail | null> {
  const { rows: irows } = await pool.query(
    `select i.*, w.name as workspace_name,
            (select count(*)::int from segments s where s.interaction_id = i.id) as segment_count
     from interactions i
     left join workspaces w on w.id = i.workspace_id
     where i.id = $1`,
    [id],
  );
  const i = irows[0];
  if (!i) return null;

  const [participants, files, jobs, transcript, facts, clips, projects, speakers] = await Promise.all([
    pool.query(
      `select pa.id, pa.name, pa.kind, ip.speaker_label, ip.confidence,
              coalesce((
                select json_agg(json_build_object(
                  'workspaceId', r.workspace_id, 'workspaceName', w.name, 'role', r.role,
                  'status', r.status, 'market', r.market, 'detail', r.detail) order by w.name, r.role)
                from roles r join workspaces w on w.id = r.workspace_id
                where r.party_id = pa.id), '[]'::json) as roles
       from interaction_participants ip
       join parties pa on pa.id = ip.party_id
       where ip.interaction_id = $1
       order by pa.kind desc, pa.name`,
      [id],
    ),
    pool.query(
      `select id, storage, bucket, storage_key, role, kind, bytes, mime_type, status, original_filename, sha256
       from media where interaction_id = $1 order by id`,
      [id],
    ),
    pool.query(
      `select j.id, j.media_id, j.stage, j.status, j.attempts, j.error, j.updated_at
       from jobs j join media m on m.id = j.media_id
       where m.interaction_id = $1 order by j.id`,
      [id],
    ),
    pool.query(`select source, model, language, segment_count, word_count from transcripts where interaction_id = $1`, [id]),
    pool.query(
      `select f.id, f.kind, f.text, f.status, f.quote_start_sec, f.amount, f.due_date,
              o.id as owner_id, o.name as owner_name, a.id as about_id, a.name as about_name
       from facts f
       left join parties o on o.id = f.owner_party_id
       left join parties a on a.id = f.about_party_id
       where f.interaction_id = $1
       order by f.quote_start_sec nulls last, f.id`,
      [id],
    ),
    pool.query(
      `select id, start_sec, end_sec, score, hook, why, status from clip_candidates
       where interaction_id = $1 order by score desc, start_sec`,
      [id],
    ),
    pool.query(
      `select pr.id, pr.name, pr.status, pr.workspace_id, w.name as workspace_name
       from interaction_links il join projects pr on pr.id = il.project_id join workspaces w on w.id = pr.workspace_id
       where il.interaction_id = $1 order by pr.name`,
      [id],
    ),
    pool.query(
      `select speaker, min(speaker_party_id) as party_id, count(*)::int as lines
       from segments where interaction_id = $1 and speaker is not null group by speaker order by min(idx)`,
      [id],
    ),
  ]);

  const candidates: PlayableCandidate[] = files.rows.map((m) => ({
    id: m.id,
    storage: m.storage,
    bucket: m.bucket,
    storageKey: m.storage_key,
    role: m.role,
    kind: m.kind,
    status: m.status,
    mimeType: m.mime_type,
  }));
  const chosen = pickVideoSource(candidates, (s, k) => storage.canServe(s, k));
  let video: RecordingDetail["video"] = null;
  if (chosen) {
    const signed = await storage.presignGet(
      { storage: chosen.storage, bucket: chosen.bucket, key: chosen.storageKey },
      { expiresInSec: PRESIGN_TTL_SEC },
    );
    if (signed) {
      video = {
        url: signed.url,
        mediaId: chosen.id,
        mimeType: chosen.mimeType,
        kind: chosen.kind,
        expiresAt: signed.expiresAt.toISOString(),
      };
    }
  }

  return {
    id: i.id,
    title: i.title,
    occurredAt: i.occurred_at ? new Date(i.occurred_at).toISOString() : null,
    durationSec: i.duration_sec,
    source: i.source,
    kind: i.kind,
    workspace: i.workspace_id ? { id: i.workspace_id, name: i.workspace_name ?? i.workspace_id } : null,
    tags: i.tags ?? [],
    summary: i.summary,
    pipelineStatus: i.pipeline_status,
    pipelineError: i.pipeline_error,
    vaultId: i.vault_id,
    originalFilename: i.original_filename,
    updatedAt: i.updated_at ? new Date(i.updated_at).toISOString() : null,
    participants: participants.rows.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      speakerLabel: p.speaker_label,
      confidence: p.confidence,
      roles: (p.roles ?? []) as RoleChip[],
    })),
    video,
    files: files.rows.map((m) => ({
      id: m.id,
      storage: m.storage,
      bucket: m.bucket,
      storageKey: m.storage_key,
      role: m.role,
      kind: m.kind,
      bytes: m.bytes,
      mimeType: m.mime_type,
      status: m.status,
      originalFilename: m.original_filename,
      sha256: m.sha256,
      playable: chosen?.id === m.id,
    })),
    jobs: jobs.rows.map((j) => ({
      id: j.id,
      mediaId: j.media_id,
      stage: j.stage,
      status: j.status,
      attempts: j.attempts,
      error: j.error,
      updatedAt: j.updated_at ? new Date(j.updated_at).toISOString() : null,
    })),
    transcript: transcript.rows[0]
      ? {
          source: transcript.rows[0].source,
          model: transcript.rows[0].model,
          language: transcript.rows[0].language,
          segmentCount: transcript.rows[0].segment_count,
          wordCount: transcript.rows[0].word_count,
        }
      : null,
    segmentCount: i.segment_count ?? 0,
    hasTranscriptText: !!(i.transcript && i.transcript.trim()),
    facts: facts.rows.map((f) => ({
      id: f.id,
      kind: f.kind,
      text: f.text,
      status: f.status,
      quoteStartSec: f.quote_start_sec,
      ownerParty: f.owner_id ? { id: f.owner_id, name: f.owner_name } : null,
      aboutParty: f.about_id ? { id: f.about_id, name: f.about_name } : null,
      amount: f.amount,
      dueDate: f.due_date ? String(f.due_date).slice(0, 10) : null,
    })),
    clips: clips.rows.map((c) => ({
      id: c.id,
      startSec: c.start_sec,
      endSec: c.end_sec,
      score: c.score,
      hook: c.hook,
      why: c.why,
      status: c.status,
    })),
    projects: projects.rows.map((p) => ({ id: p.id, name: p.name, status: p.status, workspaceId: p.workspace_id, workspaceName: p.workspace_name })),
    speakers: speakers.rows.map((s) => ({ label: s.speaker, partyId: s.party_id ?? null, lines: s.lines })),
  };
}

export async function getSegments(pool: pg.Pool, id: number): Promise<TranscriptLine[]> {
  const { rows } = await pool.query(
    `select id, idx, start_sec, end_sec, speaker, speaker_party_id, text
     from segments where interaction_id = $1 order by idx`,
    [id],
  );
  return rows.map((s) => ({
    id: s.id,
    idx: s.idx,
    startSec: s.start_sec,
    endSec: s.end_sec,
    speaker: s.speaker,
    speakerPartyId: s.speaker_party_id,
    text: s.text,
  }));
}

/** Legacy rows have no segments but do have a plain-text transcript: turn it into unanchored lines. */
export function linesFromPlainTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let idx = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:]{1,60}):\s+(.*)$/.exec(line);
    out.push({
      id: -(idx + 1),
      idx,
      startSec: 0,
      endSec: 0,
      speaker: m ? m[1] : null,
      speakerPartyId: null,
      text: m ? m[2] : line,
    });
    idx++;
  }
  return out;
}

export async function updateRecording(
  pool: pg.Pool,
  id: number,
  patch: { title?: string; tags?: string[]; workspaceId?: string | null },
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.title !== undefined) sets.push(`title = ${p(patch.title)}`);
  if (patch.tags !== undefined) sets.push(`tags = ${p(patch.tags)}::text[]`);
  if (patch.workspaceId !== undefined) sets.push(`workspace_id = ${p(patch.workspaceId)}`);
  if (!sets.length) return true;
  sets.push("updated_at = now()");
  const res = await pool.query(`update interactions set ${sets.join(", ")} where id = ${p(id)}`, params);
  return (res.rowCount ?? 0) > 0;
}
