// Hosted speech-to-text (Groq Whisper). Ported from meeting-vault's apistt.py.
//
// Audio leaves the vault for this, and it costs money, so nothing in this
// module runs unless GROQ_API_KEY is set AND GROQ_MONTHLY_BUDGET_USD allows
// the estimated cost (see budget.ts). Chunks are 16 kHz mono Opus (see
// media.ts); long recordings are split and timestamps shifted back.

import fs from "node:fs/promises";
import path from "node:path";

export const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_MODEL = "whisper-large-v3-turbo";
export const USER_AGENT = "strout-vault/0.4 (+private archive worker)";

/** $ per audio-hour, list price. Verify before relying on it. */
export const PRICE_PER_HOUR: Record<string, number> = {
  "whisper-large-v3-turbo": 0.04,
  "whisper-large-v3": 0.111,
  "distil-whisper-large-v3-en": 0.02,
};

export function pricePerHour(model: string): number {
  return PRICE_PER_HOUR[model] ?? PRICE_PER_HOUR[DEFAULT_MODEL];
}

export function estimateCostUsd(durationSec: number, model = DEFAULT_MODEL): number {
  return (Math.max(0, durationSec) / 3600) * pricePerHour(model);
}

export class SpeechApiError extends Error {}

export interface Word {
  start: number;
  end: number;
  word: string;
}
export interface SttSegment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface GroqOptions {
  apiKey: string;
  model?: string;
  url?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST one audio file, return the parsed verbose_json payload. */
export async function transcribeChunk(opts: GroqOptions, file: string, extra: { language?: string; prompt?: string } = {}): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const url = opts.url ?? GROQ_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxRetries = opts.maxRetries ?? 5;
  const bytes = await fs.readFile(file);
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (extra.language) form.set("language", extra.language);
    if (extra.prompt) form.set("prompt", extra.prompt);
    form.set("file", new Blob([bytes], { type: "audio/ogg" }), path.basename(file));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "user-agent": USER_AGENT, accept: "application/json" },
        body: form,
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(Math.min(30_000, 2 ** attempt * 1000));
        continue;
      }
      throw new SpeechApiError(`network error calling Groq: ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    const detail = (await res.text()).slice(0, 400);
    if (res.status === 429 && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep((Number.isFinite(ra) && ra > 0 ? ra : Math.min(60, 2 ** attempt)) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
      continue;
    }
    if (res.status === 401) throw new SpeechApiError("Groq rejected the API key (401). Check GROQ_API_KEY.");
    if (res.status === 403) throw new SpeechApiError(`Groq refused the request (403). If the key is valid, the account may not have billing enabled for this model. ${detail}`);
    if (res.status === 413) throw new SpeechApiError(`Groq rejected the upload as too large (${bytes.length} bytes). Lower GROQ_CHUNK_SECONDS.`);
    throw new SpeechApiError(`Groq API ${res.status}: ${detail}`);
  }
}

/**
 * Map a flat word list onto segments by time overlap. verbose_json returns
 * words at the top level, not nested per segment.
 */
export function attachWords(segments: SttSegment[], words: Word[]): void {
  if (!words.length) return;
  let index = 0;
  for (const seg of segments) {
    const segWords: Word[] = [];
    while (index < words.length && words[index].end <= seg.start + 1e-6) index++;
    let cursor = index;
    while (cursor < words.length && words[cursor].start < seg.end - 1e-6) {
      segWords.push(words[cursor]);
      cursor++;
    }
    seg.words = segWords;
    index = Math.max(index, cursor - 1);
  }
}

/** Normalize one API response into our segment shape, shifted by `offset` seconds. */
export function parseResponse(payload: Record<string, unknown>, offset = 0): { segments: SttSegment[]; language: string | null; duration: number } {
  const rawSegments = (payload.segments as Array<Record<string, unknown>> | undefined) ?? [];
  const rawWords = (payload.words as Array<Record<string, unknown>> | undefined) ?? [];
  const words: Word[] = rawWords
    .filter((w) => w.word && String(w.word).trim())
    .map((w) => ({ start: Number(w.start) + offset, end: Number(w.end) + offset, word: String(w.word).trim() }));
  const segments: SttSegment[] = [];
  for (const seg of rawSegments) {
    const text = String(seg.text ?? "").trim();
    if (!text) continue;
    const nested = (seg.words as Array<Record<string, unknown>> | undefined) ?? [];
    segments.push({
      start: Number(seg.start ?? 0) + offset,
      end: Number(seg.end ?? 0) + offset,
      text,
      words: nested.map((w) => ({ start: Number(w.start) + offset, end: Number(w.end) + offset, word: String(w.word ?? "").trim() })),
    });
  }
  const duration = Number(payload.duration ?? 0) || 0;
  if (!segments.length && String(payload.text ?? "").trim()) {
    segments.push({ start: offset, end: offset + duration, text: String(payload.text).trim(), words: [] });
  }
  if (!segments.some((s) => s.words.length)) attachWords(segments, words);
  return { segments, language: (payload.language as string | undefined) ?? null, duration };
}
