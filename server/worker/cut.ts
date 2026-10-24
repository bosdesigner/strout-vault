// Render approved clip candidates into social-ready MP4s. Ported from
// meeting-vault's clip.py / cutter.py: 9:16 centre-crop (or the whole frame),
// burned-in captions from the transcript's word timings, H.264 High / AAC,
// +faststart. The source is the full-quality original in the archive bucket,
// read straight over HTTPS so a 60-second clip never downloads a 1 GB file.
// Finished clips go to the upload bucket under clips/ and become media rows
// (role 'clip') the app can hand out with presigned URLs. Nothing is deleted.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { WorkerContext } from "./context.ts";
import { ItemError, outOfTime } from "./context.ts";
import { buildAss, captionLines, escapeFilterPath, SOCIAL_H, SOCIAL_W, verticalCrop, type CaptionSegment } from "./captions.ts";
import { ffmpeg, probeVideo } from "./media.ts";

export interface CutSummary {
  approved: number;
  rendered: number;
  failed: number;
  bytes: number;
  stoppedEarly?: string;
  errors: string[];
}

const MAX_RENDER_ATTEMPTS = 3;

interface CandidateRow {
  id: number;
  interaction_id: number;
  start_sec: number;
  end_sec: number;
  hook: string | null;
  title: string | null;
  source: string | null;
  workspace_id: string | null;
  occurred_at: Date | null;
}

interface SourceRow {
  id: number;
  storage: string;
  bucket: string | null;
  storage_key: string;
  role: string | null;
}

export async function processCuts(ctx: WorkerContext): Promise<CutSummary> {
  const summary: CutSummary = { approved: 0, rendered: 0, failed: 0, bytes: 0, errors: [] };
  const { rows } = await ctx.pool.query<CandidateRow>(
    `select c.id, c.interaction_id, c.start_sec, c.end_sec, c.hook, i.title, i.source, i.workspace_id, i.occurred_at
       from clip_candidates c join interactions i on i.id = c.interaction_id
      where c.status = 'approved' and c.clip_media_id is null and c.render_attempts < $1
      order by c.interaction_id, c.score desc, c.id
      limit $2`,
    [MAX_RENDER_ATTEMPTS, ctx.config.CLIP_MAX_PER_RUN],
  );
  summary.approved = rows.length;
  if (!rows.length) return summary;
  ctx.log(`cut: ${rows.length} approved clip(s) to render (${ctx.config.CLIP_FORMAT}, captions ${ctx.config.CLIP_CAPTIONS === "1" ? "on" : "off"})`);
  for (const cand of rows) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const label = (cand.hook || cand.title || `#${cand.id}`).slice(0, 60);
    const itemDir = path.join(ctx.tmpDir, `clip-${cand.id}-${Date.now()}`);
    try {
      const r = await renderCandidate(ctx, cand, itemDir);
      summary.rendered++;
      summary.bytes += r.bytes;
      ctx.log(`cut:   rendered "${label}" -> ${r.key} (${(r.bytes / 1024 / 1024).toFixed(1)} MB, ${r.captions} caption line(s))`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      summary.failed++;
      summary.errors.push(`"${label}": ${msg}`);
      await ctx.pool.query(`update clip_candidates set render_attempts = render_attempts + 1, render_error = $2 where id = $1`, [cand.id, msg]);
      ctx.log(`cut:   FAILED "${label}": ${msg}`);
    } finally {
      await fsp.rm(itemDir, { recursive: true, force: true });
    }
  }
  return summary;
}

/** Where the caption font lives: CLIP_FONTS_DIR, else the fonts shipped next to this module (works from source and from dist/). */
export function fontsDir(ctx: WorkerContext): string {
  if (ctx.config.CLIP_FONTS_DIR) return ctx.config.CLIP_FONTS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "assets/fonts"), path.resolve(process.cwd(), "server/worker/assets/fonts")]) {
    if (fs.existsSync(path.join(candidate, "DejaVuSans-Bold.ttf"))) return candidate;
  }
  return path.resolve(process.cwd(), "server/worker/assets/fonts");
}

async function pickSource(ctx: WorkerContext, interactionId: number): Promise<SourceRow> {
  const { rows } = await ctx.pool.query<SourceRow>(
    `select id, storage, bucket, storage_key, role from media
      where interaction_id = $1 and kind = 'video' and role in ('original', 'master') and status in ('verified', 'verified_stable')
      order by case role when 'original' then 0 else 1 end, id`,
    [interactionId],
  );
  const readable = rows.filter((m) => ctx.storage.canServe(m.storage, m.storage_key) || m.storage === ctx.storage.archiveTarget.storage);
  if (!readable.length) {
    if (!rows.length) throw new ItemError("no video original to cut from (audio-only recording, or the download has not finished)");
    throw new ItemError(`the video original is in ${rows[0].storage}, which this worker cannot read`);
  }
  return readable[0];
}

/** An ffmpeg input for a media object: a presigned URL on S3 drivers, a temp file otherwise. */
async function inputFor(ctx: WorkerContext, src: SourceRow, itemDir: string): Promise<string> {
  const location = { storage: src.storage, bucket: src.bucket, key: src.storage_key };
  if (ctx.storage.name === "s3") {
    const signed = await ctx.storage.presignGet(location, { expiresInSec: 3600 });
    if (signed) return signed.url;
  }
  const obj = await ctx.storage.getObjectStream(location);
  if (!obj) throw new ItemError(`cannot read the video from ${src.storage}`);
  await fsp.mkdir(itemDir, { recursive: true });
  const file = path.join(itemDir, `source${path.extname(src.storage_key) || ".bin"}`);
  await pipeline(obj.stream as NodeJS.ReadableStream, fs.createWriteStream(file));
  return file;
}

export function clipSlug(text: string, limit = 48): string {
  return (
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 _-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, limit)
      .replace(/-+$/, "") || "clip"
  );
}

export function clipKey(cand: { id: number; hook: string | null; title: string | null; occurred_at: Date | null }): string {
  const d = cand.occurred_at ? new Date(cand.occurred_at) : new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `clips/${yyyy}/${mm}/${cand.id}_${clipSlug(cand.hook || cand.title || "clip")}.mp4`;
}

export async function renderCandidate(ctx: WorkerContext, cand: CandidateRow, itemDir: string): Promise<{ key: string; bytes: number; captions: number }> {
  const cfg = ctx.config;
  await fsp.mkdir(itemDir, { recursive: true });
  const src = await pickSource(ctx, cand.interaction_id);
  const input = await inputFor(ctx, src, itemDir);
  const info = await probeVideo(ctx.tools, input);
  if (!info.hasVideo || !info.width || !info.height) throw new ItemError("the source has no video stream");

  const pad = cfg.CLIP_PADDING_SEC;
  let padStart = Math.max(0, Number(cand.start_sec) - pad);
  let padEnd = Number(cand.end_sec) + pad;
  if (info.duration) {
    padEnd = Math.min(padEnd, info.duration);
    if (padStart >= info.duration) throw new ItemError(`the clip starts at ${padStart.toFixed(0)} s, past the end of the recording (${info.duration.toFixed(0)} s)`);
  }
  const duration = padEnd - padStart;
  if (duration <= 0) throw new ItemError("the clip has no duration after clamping to the recording");
  padStart = Math.round(padStart * 1000) / 1000;

  // ---- video filters ----
  const filters: string[] = [];
  let outW: number;
  let outH: number;
  const vertical = cfg.CLIP_FORMAT === "vertical";
  if (vertical) {
    const [cw, ch, cx, cy] = verticalCrop(info.width, info.height);
    filters.push(`crop=${cw}:${ch}:${cx}:${cy}`, `scale=${SOCIAL_W}:${SOCIAL_H}:flags=lanczos`);
    outW = SOCIAL_W;
    outH = SOCIAL_H;
  } else {
    outW = Math.min(1920, info.width);
    outW -= outW % 2;
    outH = Math.round((outW * info.height) / info.width);
    outH -= outH % 2;
    filters.push(`scale=${outW}:-2:flags=lanczos`);
  }
  filters.push("setsar=1");

  // ---- captions ----
  let captionCount = 0;
  if (cfg.CLIP_CAPTIONS === "1") {
    const { rows: segs } = await ctx.pool.query<{ start_sec: number; end_sec: number; text: string; words: unknown }>(
      `select start_sec, end_sec, text, words from segments where interaction_id = $1 and end_sec > $2 and start_sec < $3 order by idx`,
      [cand.interaction_id, padStart, padEnd],
    );
    const segments: CaptionSegment[] = segs.map((s) => ({
      start: Number(s.start_sec),
      end: Number(s.end_sec),
      text: s.text,
      words: Array.isArray(s.words) ? (s.words as Array<{ start: number; end: number; word: string }>) : null,
    }));
    const lines = captionLines(segments, padStart, padEnd);
    captionCount = lines.length;
    if (lines.length) {
      const assPath = path.join(itemDir, "captions.ass");
      await fsp.writeFile(assPath, buildAss(lines, outW, outH), "utf8");
      filters.push(`subtitles=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir(ctx))}`);
    }
  }

  // ---- render ----
  const out = path.join(itemDir, "clip.mp4");
  const args = ["-ss", padStart.toFixed(3), "-i", input, "-t", duration.toFixed(3), "-vf", filters.join(","), "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20", "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  if (info.hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push(out);
  await ffmpeg(ctx.tools, args);
  const result = await probeVideo(ctx.tools, out);

  // ---- store ----
  const key = clipKey(cand);
  const target = ctx.storage.uploadTarget;
  const { bytes, sha256 } = await ctx.storage.putStream({ storage: target.storage, bucket: target.bucket, key, body: fs.createReadStream(out), contentType: "video/mp4" });

  const db = await ctx.pool.connect();
  try {
    await db.query("begin");
    const media = await db.query<{ id: number }>(
      `insert into media (interaction_id, workspace_id, source, storage, bucket, storage_key, mime_type, bytes, duration_sec, recorded_at, original_filename, kind, role, sha256, status, derived_from, verified_at)
       values ($1, $2, $3, $4, $5, $6, 'video/mp4', $7, $8, $9, $10, 'video', 'clip', $11, 'verified', $12, now()) returning id`,
      [cand.interaction_id, cand.workspace_id, cand.source ?? "other", target.storage, target.bucket, key, bytes, Math.round(result.duration ?? duration), cand.occurred_at, path.basename(key), sha256, src.id],
    );
    const mediaId = media.rows[0].id;
    await db.query(
      `insert into clips (interaction_id, media_id, path, start_sec, end_sec, vertical, captions, source_role, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [cand.interaction_id, mediaId, key, padStart, padEnd, vertical, captionCount > 0, src.role ?? "original", bytes],
    );
    await db.query(`update clip_candidates set status = 'cut', clip_media_id = $2, clip_path = $3, rendered_at = now(), render_error = null where id = $1`, [cand.id, mediaId, key]);
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  return { key, bytes, captions: captionCount };
}
