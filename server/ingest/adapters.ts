// Every way a conversation gets into the vault, in one list. Each source is an adapter:
//
//   pull   the worker fetches it on a schedule: `run` is the worker step (its name is `step`).
//   push   something outside sends it to an /api/ingest route (a Mac collector, a Shortcut, a webhook);
//          the adapter only describes it.
//
// What the rest of the pipeline reads from here:
//   - the worker's step list and dispatch (server/worker/run.ts): every pull adapter's step runs
//     after the core sources, in this order;
//   - the participant resolver (server/worker/resolve.ts): sources with resolveParticipants;
//   - filing rules (config/filing_rules.yml) apply to every source; `sources:` on a rule narrows it.
//
// Adding a source (Phase 2: Google Meet via Drive is already the `meet` adapter; TikTok and Instagram
// DMs would be `dm_thread` with source tiktok / instagram):
//   1. write server/ingest/<source>.ts exporting an IngestAdapter (a pull adapter's run() writes
//      interactions + segments through server/messages/ingest.ts ingestThread for message-like
//      sources, or interactions + media + a transcribe job like server/worker/sync.ts for recordings);
//   2. add it to INGEST_ADAPTERS below (the "config entry"), plus a filing rule if titles say where it goes;
//   3. a new interactions.kind or .source value needs a migration widening the check constraints
//      (see 0009 / 0010), and the MCP kind enum (server/mcp/tools/schemas.ts).
// Extraction, embedding, search, MCP and follow-through need nothing: they read interactions and segments.
import type { WorkerContext } from "../worker/context.ts";
import { syncZoom } from "../worker/sync.ts";
import { processMeet } from "../worker/meet.ts";
import { processGmail } from "../worker/gmail.ts";

export interface IngestAdapter {
  /** interactions.source */
  source: string;
  /** interactions.kind values it writes. */
  kinds: string[];
  mode: "pull" | "push";
  /** Pull adapters: the worker step name and what it runs. */
  step?: string;
  run?: (ctx: WorkerContext, opts: { dryRun?: boolean }) => Promise<unknown>;
  /** Push adapters: where it arrives. */
  entry?: string;
  /** The participant resolver links these to their people and files them (server/participants/resolve.ts). */
  resolveParticipants: boolean;
  description: string;
}

export const INGEST_ADAPTERS: IngestAdapter[] = [
  { source: "zoom", kinds: ["meeting"], mode: "pull", step: "zoom", run: (ctx, o) => syncZoom(ctx, o), resolveParticipants: true, description: "Zoom cloud recordings (Server-to-Server OAuth, recording:read:admin)" },
  { source: "meet", kinds: ["meeting"], mode: "pull", step: "meet", run: (ctx, o) => processMeet(ctx, o), resolveParticipants: true, description: "Google Meet recordings and transcripts from Drive (drive.meet.readonly)" },
  { source: "gmail", kinds: ["email_thread"], mode: "pull", step: "gmail", run: (ctx, o) => processGmail(ctx, o), resolveParticipants: false, description: "Gmail threads (gmail.readonly)" },
  { source: "imessage", kinds: ["text_thread"], mode: "push", entry: "POST /api/ingest/messages", resolveParticipants: false, description: "iMessage / SMS from the Mac collector (collectors/imessage)" },
  { source: "iphone_call", kinds: ["call"], mode: "push", entry: "POST /api/ingest/device/{presign,finalize}", resolveParticipants: true, description: "iPhone call recordings, saved by iOS into Apple Notes, sent by the Mac media collector" },
  { source: "voice_memo", kinds: ["recording"], mode: "push", entry: "POST /api/ingest/device/{presign,finalize}", resolveParticipants: false, description: "Voice Memos from the Mac media collector or the iPhone Shortcut" },
  { source: "apple_note", kinds: ["note"], mode: "push", entry: "POST /api/ingest/device/note", resolveParticipants: false, description: "Apple Notes, text only, from the Mac media collector" },
  { source: "contractor_call", kinds: ["call"], mode: "push", entry: "POST /webhooks/twilio/*", resolveParticipants: false, description: "Tracked contractor phone numbers (Twilio)" },
  { source: "upload", kinds: ["other"], mode: "push", entry: "POST /api/uploads/*", resolveParticipants: false, description: "Files uploaded on the web app" },
  // Phase 2 (not built): { source: "tiktok", kinds: ["dm_thread"], mode: "push", entry: "POST /api/ingest/messages", ... }
  //                      { source: "instagram", kinds: ["dm_thread"], mode: "push", entry: "POST /api/ingest/messages", ... }
];

/** Worker steps that come from pull adapters, in registry order. */
export const PULL_STEPS = INGEST_ADAPTERS.filter((a) => a.mode === "pull" && a.step && a.run).map((a) => a.step!);

export function pullAdapter(step: string): IngestAdapter | undefined {
  return INGEST_ADAPTERS.find((a) => a.mode === "pull" && a.step === step);
}

/** Sources the participant resolver works on. */
export const RESOLVED_SOURCES = INGEST_ADAPTERS.filter((a) => a.resolveParticipants).map((a) => a.source);
