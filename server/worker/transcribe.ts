// Transcription step: every recording that has a verified original but no
// transcript gets one. Order of preference (TRANSCRIBE_PREFER=zoom):
//
//   1. Zoom's TRANSCRIPT file (free, already timestamped, speaker-labelled)
//   2. Zoom's CC file (the live captions, same engine, no speaker names)
//   3. Groq Whisper, only when GROQ_API_KEY is set and the month's budget allows
//
// Google Meet's transcript Doc (media kind transcript_meet, exported as text by the meet step)
// counts as the platform's own transcript, exactly like Zoom's TRANSCRIPT file.
//
// Segments are written in one transaction per recording, so a crash never
// leaves half a transcript behind and nothing ever needs deleting.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { WorkerContext } from "./context.ts";
import { ItemError, outOfTime } from "./context.ts";
import { checkBudget, recordSpend } from "./budget.ts";
import { estimateCostUsd, parseResponse, transcribeChunk, type SttSegment } from "./groq.ts";
import { prepareOpus, probeDuration, splitAudio } from "./media.ts";
import { cuesToPlainText, parseVtt } from "./vtt.ts";
import { parseMeetTranscript } from "../meet/transcript.ts";

export interface TranscribeSummary {
  candidates: number;
  done: number;
  viaZoomTranscript: number;
  viaZoomCaptions: number;
  viaMeetTranscript?: number;
  viaGroq: number;
  waitingOnBudget: number;
  failed: number;
  spentUsd: number;
  stoppedEarly?: string;
  errors: string[];
}

interface Candidate {
  id: number;
  title: string | null;
  source: string | null;
  duration_sec: number | null;
}

interface MediaRow {
  id: number;
  kind: string;
  storage: string;
  bucket: string | null;
  storage_key: string;
  bytes: number | null;
  duration_sec: number | null;
  status: string;
}

interface Written {
  source: string;
  model: string | null;
  language: string | null;
  hasWords: boolean;
  durationSec: number | null;
  segments: Array<{ start: number; end: number; speaker: string | null; text: string; words: unknown | null }>;
  costUsd?: number;
}

const MAX_AUTO_ATTEMPTS = 3;
const BATCH = 50;

export async function processTranscriptions(ctx: WorkerContext): Promise<TranscribeSummary> {
  const summary: TranscribeSummary = {
    candidates: 0,
    done: 0,
    viaZoomTranscript: 0,
    viaZoomCaptions: 0,
    viaMeetTranscript: 0,
    viaGroq: 0,
    waitingOnBudget: 0,
    failed: 0,
    spentUsd: 0,
    errors: [],
  };
  const { rows } = await ctx.pool.query<Candidate>(
    `select i.id, i.title, i.source, i.duration_sec
       from interactions i
      where not exists (select 1 from transcripts t where t.interaction_id = i.id)
        and not exists (select 1 from segments s where s.interaction_id = i.id)
        and exists (select 1 from media m where m.interaction_id = i.id and m.role = 'original'
                      and m.status in ('verified', 'verified_stable') and m.kind in ('video', 'audio', 'transcript_vtt', 'caption_vtt', 'transcript_meet'))
        and (
          i.pipeline_status = 'queued'
          or (i.pipeline_status = 'transcribing' and coalesce(i.pipeline_updated_at, now() - interval '1 day') < now() - interval '2 hours')
          or (i.pipeline_status = 'failed' and coalesce(i.pipeline_updated_at, now()) < now() - interval '1 hour'
              and coalesce((select max(j.attempts) from jobs j join media m on m.id = j.media_id where m.interaction_id = i.id and j.stage = 'transcribe'), 0) < $1)
        )
      order by i.occurred_at desc nulls last, i.id desc
      limit $2`,
    [MAX_AUTO_ATTEMPTS, BATCH],
  );
  summary.candidates = rows.length;
  if (rows.length) ctx.log(`transcribe: ${rows.length} recording(s) waiting`);
  for (const c of rows) {
    if (outOfTime(ctx)) {
      summary.stoppedEarly = "time budget";
      break;
    }
    const label = c.title?.trim() || `#${c.id}`;
    await setPipeline(ctx, c.id, "transcribing", null);
    const itemDir = path.join(ctx.tmpDir, `i${c.id}-${Date.now()}`);
    try {
      const written = await transcribeOne(ctx, c, itemDir);
      if (written === "budget") {
        summary.waitingOnBudget++;
        continue;
      }
      await writeTranscript(ctx, c.id, written);
      summary.done++;
      if (written.source === "zoom_vtt") summary.viaZoomTranscript++;
      else if (written.source === "zoom_cc") summary.viaZoomCaptions++;
      else if (written.source === "meet_doc") summary.viaMeetTranscript = (summary.viaMeetTranscript ?? 0) + 1;
      else if (written.source === "groq") summary.viaGroq++;
      summary.spentUsd += written.costUsd ?? 0;
      ctx.log(`transcribe:   ${label}: ${written.segments.length} segments via ${written.source}${written.costUsd ? ` ($${written.costUsd.toFixed(3)})` : ""}`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      summary.failed++;
      summary.errors.push(`${label}: ${msg}`);
      await setPipeline(ctx, c.id, "failed", msg);
      await bumpJob(ctx, c.id, "failed", msg);
      ctx.log(`transcribe:   ${label}: FAILED ${msg}`);
    } finally {
      await fsp.rm(itemDir, { recursive: true, force: true });
    }
  }
  return summary;
}

async function transcribeOne(ctx: WorkerContext, c: Candidate, itemDir: string): Promise<Written | "budget"> {
  const { rows: media } = await ctx.pool.query<MediaRow>(
    `select id, kind, storage, bucket, storage_key, bytes, duration_sec, status from media
      where interaction_id = $1 and role = 'original' and status in ('verified', 'verified_stable') order by id`,
    [c.id],
  );
  const reachable = media.filter((m) => canRead(ctx, m));
  const vtt = reachable.find((m) => m.kind === "transcript_vtt");
  const cc = reachable.find((m) => m.kind === "caption_vtt");
  const meetDoc = reachable.find((m) => m.kind === "transcript_meet");
  const audio = reachable.find((m) => m.kind === "audio") ?? reachable.find((m) => m.kind === "video");
  const prefer = ctx.config.TRANSCRIBE_PREFER;

  const tryZoom = async (): Promise<Written | null> => {
    if (meetDoc) {
      const parsed = parseMeetTranscript(await readText(ctx, meetDoc, 32 * 1024 * 1024), c.duration_sec);
      if (parsed.segments.length) {
        return {
          source: "meet_doc",
          model: null,
          language: null,
          hasWords: false,
          durationSec: c.duration_sec ?? parsed.durationSec,
          segments: parsed.segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text, words: null })),
        };
      }
    }
    for (const [m, source] of [
      [vtt, "zoom_vtt"],
      [cc, "zoom_cc"],
    ] as Array<[MediaRow | undefined, string]>) {
      if (!m) continue;
      const text = await readText(ctx, m, 32 * 1024 * 1024);
      const cues = parseVtt(text);
      if (cues.length < 1) continue;
      return {
        source,
        model: null,
        language: null,
        hasWords: false,
        durationSec: c.duration_sec ?? Math.ceil(cues[cues.length - 1].end),
        segments: cues.map((q) => ({ start: q.start, end: q.end, speaker: q.speaker, text: q.text, words: null })),
      };
    }
    return null;
  };

  if (prefer === "zoom") {
    const z = await tryZoom();
    if (z) return z;
  }
  if (!audio) {
    if (prefer === "groq") {
      const z = await tryZoom();
      if (z) return z;
    }
    throw new ItemError("no transcript file and no readable audio or video original");
  }
  const g = await viaGroq(ctx, c, audio, itemDir);
  if (g === "budget" && prefer === "groq") {
    const z = await tryZoom();
    if (z) return z;
  }
  return g;
}

function canRead(ctx: WorkerContext, m: MediaRow): boolean {
  if (m.storage === "local") return ctx.storage.canServe("local", m.storage_key);
  return ctx.storage.canServe(m.storage, m.storage_key) || m.storage === ctx.storage.archiveTarget.storage;
}

async function readText(ctx: WorkerContext, m: MediaRow, maxBytes: number): Promise<string> {
  const obj = await ctx.storage.getObjectStream({ storage: m.storage, bucket: m.bucket, key: m.storage_key });
  if (!obj) throw new ItemError(`cannot read ${m.kind} from ${m.storage}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of obj.stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new ItemError(`${m.kind} is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function viaGroq(ctx: WorkerContext, c: Candidate, audio: MediaRow, itemDir: string): Promise<Written | "budget"> {
  const cfg = ctx.config;
  const provider = "groq";
  const model = cfg.GROQ_MODEL;
  const budgetUsd = cfg.GROQ_API_KEY ? cfg.GROQ_MONTHLY_BUDGET_USD : 0;
  // Pre-check with what we know, so nothing is downloaded when Groq is off or exhausted.
  const knownDuration = c.duration_sec ?? audio.duration_sec ?? 0;
  const pre = await checkBudget(ctx.pool, provider, budgetUsd, estimateCostUsd(knownDuration, model), ctx.now());
  if (!pre.allowed) {
    await setPipeline(ctx, c.id, "queued", `waiting: ${pre.reason}`);
    return "budget";
  }

  await fsp.mkdir(itemDir, { recursive: true });
  const src = path.join(itemDir, `source${path.extname(audio.storage_key) || ".bin"}`);
  const obj = await ctx.storage.getObjectStream({ storage: audio.storage, bucket: audio.bucket, key: audio.storage_key });
  if (!obj) throw new ItemError(`cannot read ${audio.kind} from ${audio.storage}`);
  await pipeline(obj.stream as NodeJS.ReadableStream, fs.createWriteStream(src));
  const duration = (await probeDuration(ctx.tools, src)) ?? knownDuration;
  const estimate = estimateCostUsd(duration, model);
  const check = await checkBudget(ctx.pool, provider, budgetUsd, estimate, ctx.now());
  if (!check.allowed) {
    await setPipeline(ctx, c.id, "queued", `waiting: ${check.reason}`);
    return "budget";
  }

  const opus = await prepareOpus(ctx.tools, src, path.join(itemDir, "audio.ogg"), cfg.GROQ_AUDIO_KBPS);
  const size = (await fsp.stat(opus)).size;
  const limit = cfg.GROQ_MAX_UPLOAD_MB * 1024 * 1024;
  const pieces = size > limit ? await splitAudio(ctx.tools, opus, path.join(itemDir, "chunks"), cfg.GROQ_CHUNK_SECONDS) : [{ path: opus, offsetSec: 0 }];
  const all: SttSegment[] = [];
  let language: string | null = null;
  let apiDuration = 0;
  for (const piece of pieces) {
    const payload = await transcribeChunk(
      { apiKey: cfg.GROQ_API_KEY!, model, url: cfg.GROQ_URL, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep },
      piece.path,
    );
    const parsed = parseResponse(payload, piece.offsetSec);
    all.push(...parsed.segments);
    language ??= parsed.language;
    apiDuration += parsed.duration;
  }
  all.sort((a, b) => a.start - b.start);
  const billedSec = apiDuration || duration;
  const cost = estimateCostUsd(billedSec, model);
  await recordSpend(ctx.pool, { provider, model, interactionId: c.id, unitsSec: billedSec, usd: cost, note: `${pieces.length} chunk(s)` });
  return {
    source: "groq",
    model,
    language,
    hasWords: all.some((s) => s.words.length > 0),
    durationSec: duration || null,
    segments: all.map((s) => ({ start: s.start, end: s.end, speaker: null, text: s.text, words: s.words.length ? s.words : null })),
    costUsd: cost,
  };
}

/** One transaction: transcript row, segments, plain text, status, job. */
async function writeTranscript(ctx: WorkerContext, interactionId: number, w: Written): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    const wordCount = w.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    await client.query(
      `insert into transcripts (interaction_id, source, model, language, segment_count, word_count, has_words, duration_sec)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (interaction_id) do update set source = excluded.source, model = excluded.model, language = excluded.language,
         segment_count = excluded.segment_count, word_count = excluded.word_count, has_words = excluded.has_words, duration_sec = excluded.duration_sec`,
      [interactionId, w.source, w.model, w.language, w.segments.length, wordCount, w.hasWords, w.durationSec],
    );
    const CHUNK = 500;
    for (let i = 0; i < w.segments.length; i += CHUNK) {
      const slice = w.segments.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      slice.forEach((s, j) => {
        const idx = i + j;
        params.push(interactionId, idx, s.start, s.end, s.speaker, s.text, s.words ? JSON.stringify(s.words) : null);
        const b = params.length - 7;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
      });
      await client.query(`insert into segments (interaction_id, idx, start_sec, end_sec, speaker, text, words) values ${values.join(", ")}`, params);
    }
    await client.query(
      `update interactions set transcript = $2, duration_sec = coalesce(duration_sec, $3), pipeline_status = 'ready', pipeline_error = null, pipeline_updated_at = now(), updated_at = now()
        where id = $1`,
      [interactionId, cuesToPlainText(w.segments), w.durationSec],
    );
    await client.query(
      `update jobs j set status = 'done', error = null, attempts = j.attempts + 1, updated_at = now()
        from media m where m.id = j.media_id and m.interaction_id = $1 and j.stage = 'transcribe'`,
      [interactionId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setPipeline(ctx: WorkerContext, interactionId: number, status: string, error: string | null) {
  await ctx.pool.query(`update interactions set pipeline_status = $2, pipeline_error = $3, pipeline_updated_at = now() where id = $1`, [interactionId, status, error]);
}

async function bumpJob(ctx: WorkerContext, interactionId: number, status: string, error: string | null) {
  await ctx.pool.query(
    `update jobs j set status = $2, error = $3, attempts = j.attempts + 1, updated_at = now()
       from media m where m.id = j.media_id and m.interaction_id = $1 and j.stage = 'transcribe'`,
    [interactionId, status, error],
  );
}
