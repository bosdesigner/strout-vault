import type pg from "pg";
import type { StorageDriver } from "../storage/types.ts";
import { assertSafeKey } from "../storage/types.ts";
import type { UploadFinishInput } from "../../shared/types.ts";

export class UploadError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface DuplicateInfo {
  mediaId: number;
  interactionId: number | null;
  title: string | null;
}

export async function findDuplicateBySha(pool: pg.Pool, sha256: string): Promise<DuplicateInfo | null> {
  const { rows } = await pool.query(
    `select m.id as media_id, m.interaction_id, i.title
     from media m left join interactions i on i.id = m.interaction_id
     where m.sha256 = $1
     order by (m.interaction_id is null), m.id
     limit 1`,
    [sha256.toLowerCase()],
  );
  if (!rows[0]) return null;
  return { mediaId: rows[0].media_id, interactionId: rows[0].interaction_id, title: rows[0].title };
}

const SOURCE_KIND: Record<UploadFinishInput["source"], string> = {
  upload: "other",
  iphone_call: "call",
  contractor_call: "call",
  voice_memo: "recording",
};

/**
 * Records a finished upload in one transaction:
 *   interactions (pipeline_status='queued') -> media (role='original', status='verified')
 *   -> jobs transcribe + extract (pending) -> interaction_participants.
 * Anything failing rolls the whole thing back. The object itself stays in
 * storage (the app never deletes); a retry of the same file is refused as a
 * duplicate by sha256 once the row exists.
 */
export async function finishUpload(
  pool: pg.Pool,
  storage: StorageDriver,
  input: UploadFinishInput,
  opts: { uploadedBy?: number | null; forceWorkspaceId?: string | null } = {},
): Promise<{ interactionId: number; mediaId: number }> {
  // A contractor's upload always lands in their workspace, tagged with them, so they can see it afterwards.
  if (opts.forceWorkspaceId !== undefined && opts.forceWorkspaceId !== null) input = { ...input, workspaceId: opts.forceWorkspaceId };
  if (opts.uploadedBy) input = { ...input, partyIds: [...new Set([...input.partyIds, opts.uploadedBy])] };
  assertSafeKey(input.key);
  if (!input.key.startsWith("uploads/")) throw new UploadError(400, "bad_key", "key must be under uploads/");
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new UploadError(400, "bad_sha256", "sha256 must be 64 hex chars");
  if (!(input.source in SOURCE_KIND)) throw new UploadError(400, "bad_source", "unknown source");
  const recordedAt = new Date(input.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) throw new UploadError(400, "bad_date", "recordedAt is not a date");

  const target = storage.uploadTarget;
  const head = await storage.head({ storage: target.storage, bucket: target.bucket, key: input.key });
  if (!head) throw new UploadError(409, "object_missing", "the uploaded object is not in storage");
  if (head.bytes !== input.bytes) {
    throw new UploadError(409, "size_mismatch", `storage has ${head.bytes} bytes, upload reported ${input.bytes}`);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const dup = await client.query(`select id, interaction_id from media where sha256 = $1 limit 1`, [input.sha256.toLowerCase()]);
    // A device item already filed under its own id (the Mac collector re-sending an edited file's twin).
    if (!dup.rows[0] && input.sourceRef) {
      const ref = await client.query(`select id as interaction_id, media_id as id from interactions where source = $1 and source_ref = $2`, [input.source, input.sourceRef]);
      if (ref.rows[0]) dup.rows.push(ref.rows[0]);
    }
    if (dup.rows[0]) {
      await client.query("rollback");
      const t = dup.rows[0].interaction_id
        ? await pool.query(`select title from interactions where id = $1`, [dup.rows[0].interaction_id])
        : { rows: [] as Array<{ title: string | null }> };
      throw new UploadError(409, "duplicate", "Already in the vault", {
        duplicate: { mediaId: dup.rows[0].id, interactionId: dup.rows[0].interaction_id, title: t.rows[0]?.title ?? null },
      });
    }

    const title = input.title.trim() || input.originalFilename;
    const inter = await client.query(
      `insert into interactions (workspace_id, kind, occurred_at, title, source, original_filename, content_sha256,
                                 source_ref, duration_sec, participants_raw, source_payload,
                                 pipeline_status, pipeline_updated_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, 'queued', now(), now())
       returning id`,
      [input.workspaceId || null, SOURCE_KIND[input.source], recordedAt.toISOString(), title, input.source,
       input.originalFilename, input.sha256.toLowerCase(), input.sourceRef ?? null,
       input.durationSec != null && Number.isFinite(input.durationSec) ? input.durationSec : null,
       input.participantsRaw ? JSON.stringify(input.participantsRaw) : null,
       input.sourcePayload ? JSON.stringify(input.sourcePayload) : null],
    );
    const interactionId: number = inter.rows[0].id;

    const med = await client.query(
      `insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, kind, role,
                          mime_type, bytes, bytes_expected, sha256, status, recorded_at, uploaded_by,
                          original_filename, verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'original', $8, $9, $9, $10, 'verified', $11, $12, $13, now())
       returning id`,
      [
        interactionId,
        input.workspaceId || null,
        input.source,
        target.storage,
        target.bucket,
        input.key,
        kindFromMime(input.mimeType, input.originalFilename),
        input.mimeType,
        input.bytes,
        input.sha256.toLowerCase(),
        recordedAt.toISOString(),
        opts.uploadedBy ?? null,
        input.originalFilename,
      ],
    );
    const mediaId: number = med.rows[0].id;

    await client.query(`update interactions set media_id = $1 where id = $2`, [mediaId, interactionId]);
    // Only the transcribe job: extraction is tracked on interactions.extracted_at (docs/phase1-map.md),
    // and an extract job here was never consumed by anything.
    await client.query(`insert into jobs (media_id, stage, status) values ($1, 'transcribe', 'pending')`, [mediaId]);
    const partyIds = [...new Set(input.partyIds.filter((n) => Number.isInteger(n) && n > 0))];
    if (partyIds.length) {
      await client.query(
        `insert into interaction_participants (interaction_id, party_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [interactionId, partyIds],
      );
    }
    await client.query("commit");
    return { interactionId, mediaId };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    const code = (err as { code?: string }).code;
    if (code === "23503") throw new UploadError(400, "unknown_reference", "a workspace or person on this upload does not exist");
    // Two sends of the same device item racing each other: the unique indexes on (source, source_ref)
    // and media_device_sha let exactly one through; the other is the duplicate it is.
    if (code === "23505") {
      const again = await findDuplicate(pool, input);
      if (again) throw new UploadError(409, "duplicate", "Already in the vault", { duplicate: again });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function findDuplicate(pool: pg.Pool, input: UploadFinishInput): Promise<DuplicateInfo | null> {
  const bySha = await findDuplicateBySha(pool, input.sha256);
  if (bySha) return bySha;
  if (!input.sourceRef) return null;
  const { rows } = await pool.query(`select id, media_id, title from interactions where source = $1 and source_ref = $2`, [input.source, input.sourceRef]);
  return rows[0] ? { mediaId: rows[0].media_id, interactionId: rows[0].id, title: rows[0].title } : null;
}

export function kindFromMime(mime: string | null | undefined, filename: string): "video" | "audio" {
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("video/")) return "video";
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && ["m4a", "mp3", "wav", "aac", "flac", "ogg"].includes(ext) ? "audio" : "video";
}
