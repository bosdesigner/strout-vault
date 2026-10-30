// Message source adapters (Phase 2 hook). A new conversation source is one adapter file plus one
// entry in config/sources.yml:
//
//   1. server/messages/adapters/<source>.ts exports a ThreadAdapter: a zod schema for what its
//      collector POSTs, and toThreads() turning a batch into ThreadInput[] (one thread per
//      conversation per local day, the way imessage.ts does it, kind "dm_thread").
//   2. Register it in ADAPTERS below.
//   3. List it under `enabled:` in config/sources.yml.
//
// The collector then POSTs to /api/ingest/threads/<source> with an ingest:messages token, and the
// thread goes through the same path as texts and email: blocklist and redaction, party matching
// (handles like "tiktok:@name" are kept as names until a party carries them), inbox, then the
// worker's link, classify (content routing, phalanx guard) and extract steps. Nothing else changes.
//
// Planned, not built: tiktok_dm (the existing TikTok DM scrape) and instagram_dm.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ZodType } from "zod";
import type { ThreadInput } from "../ingest.ts";

export interface ThreadAdapter<T = unknown> {
  /** interactions.source and the URL segment: lowercase, e.g. "tiktok_dm". */
  source: string;
  kind: "dm_thread" | "text_thread" | "email_thread";
  schema: ZodType<T>;
  toThreads(batch: T): ThreadInput[];
}

/** Every adapter the code knows. Enabling one is config/sources.yml's job. */
export const ADAPTERS: Record<string, ThreadAdapter<any>> = {
  // tiktok_dm: tiktokDmAdapter,      (server/messages/adapters/tiktok_dm.ts, Phase 2)
  // instagram_dm: instagramDmAdapter, (server/messages/adapters/instagram_dm.ts, Phase 2)
};

/** Sources listed under `enabled:` in config/sources.yml that also have an adapter. */
export function enabledAdapters(configDir: string, adapters: Record<string, ThreadAdapter<any>> = ADAPTERS): Map<string, ThreadAdapter<any>> {
  const out = new Map<string, ThreadAdapter<any>>();
  let enabled: string[] = [];
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(configDir, "sources.yml"), "utf8")) as { enabled?: unknown } | null;
    enabled = Array.isArray(doc?.enabled) ? doc!.enabled.map(String) : [];
  } catch {
    enabled = [];
  }
  for (const s of enabled) if (adapters[s]) out.set(s, adapters[s]);
  return out;
}
