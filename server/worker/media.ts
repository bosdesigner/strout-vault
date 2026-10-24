// ffmpeg / ffprobe wrappers. Everything that shells out goes through here so
// command lines never pass through a shell (paths are arguments) and errors
// come back readable.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export class MediaToolError extends Error {}

function run(bin: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new MediaToolError(`${bin} is not installed (set FFMPEG_BIN / FFPROBE_BIN, or add pkgs.ffmpeg to replit.nix)`));
          return;
        }
        const tail = String(stderr || "")
          .trim()
          .split("\n")
          .slice(-4)
          .join(" | ");
        reject(new MediaToolError(`${path.basename(bin)} failed: ${tail || err.message}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface VideoInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Streams and duration of a file or URL (ffprobe reads https with range requests). */
export async function probeVideo(tools: MediaTools, input: string): Promise<VideoInfo> {
  const { stdout } = await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", input]);
  const parsed = JSON.parse(stdout || "{}") as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const d = parseFloat(parsed.format?.duration ?? "");
  return {
    duration: Number.isFinite(d) && d > 0 ? d : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: !!parsed.streams?.some((s) => s.codec_type === "audio"),
    hasVideo: !!video,
  };
}

/** Run ffmpeg with the given arguments (no shell; paths and URLs are plain arguments). */
export async function ffmpeg(tools: MediaTools, args: string[]): Promise<void> {
  await run(tools.ffmpeg, ["-y", "-v", "error", "-nostdin", ...args]);
}

/** Duration in seconds, or null when ffprobe cannot tell. */
export async function probeDuration(tools: MediaTools, file: string): Promise<number | null> {
  const { stdout } = await run(tools.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const n = parseFloat(stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Downsample to 16 kHz mono Opus, what Whisper consumes minus the bulk
 * (~9 MB per hour at 24 kbps against ~34 MB/hour for Zoom's M4A).
 */
export async function prepareOpus(tools: MediaTools, source: string, dest: string, kbps = 24): Promise<string> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await run(tools.ffmpeg, ["-y", "-v", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", dest]);
  return dest;
}

/** Split into fixed-length pieces. Returns [{ path, offsetSec }] with measured offsets. */
export async function splitAudio(tools: MediaTools, source: string, outDir: string, seconds: number): Promise<Array<{ path: string; offsetSec: number }>> {
  await fs.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "chunk_%04d.ogg");
  await run(tools.ffmpeg, ["-y", "-v", "error", "-i", source, "-f", "segment", "-segment_time", String(seconds), "-c", "copy", "-reset_timestamps", "1", pattern]);
  const names = (await fs.readdir(outDir)).filter((n) => /^chunk_\d{4}\.ogg$/.test(n)).sort();
  const out: Array<{ path: string; offsetSec: number }> = [];
  let cursor = 0;
  for (const n of names) {
    const p = path.join(outDir, n);
    out.push({ path: p, offsetSec: cursor });
    // Measure each chunk: codec frame boundaries put the real cut near, not on, the mark.
    cursor += (await probeDuration(tools, p)) ?? seconds;
  }
  return out;
}

export async function toolsAvailable(tools: MediaTools): Promise<{ ok: boolean; error?: string }> {
  try {
    await run(tools.ffmpeg, ["-version"]);
    await run(tools.ffprobe, ["-version"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
