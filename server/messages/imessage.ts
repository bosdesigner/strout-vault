// What the iMessage collector on Ben's Mac POSTs to /api/ingest/messages, and how a batch
// becomes threads: one text_thread per conversation (chat guid) per local calendar day in
// America/Chicago, source_ref "imessage:<chat_guid>:<YYYY-MM-DD>". A day with no messages has
// no row. Batches may split a day; the ingest merges them by message guid.
import { z } from "zod";
import { localDay, type ThreadInput } from "./ingest.ts";

export const MAX_BATCH_MESSAGES = 2000;

const attachment = z.object({
  filename: z.string().max(500).nullable().optional(),
  mime: z.string().max(200).nullable().optional(),
  size: z.coerce.number().int().min(0).nullable().optional(),
});

export const ingestMessageSchema = z.object({
  guid: z.string().min(1).max(200),
  chat_guid: z.string().min(1).max(300),
  chat_name: z.string().max(300).nullable().optional(),
  /** Every handle in the chat other than Ben (phone numbers or emails). */
  chat_participants: z.array(z.string().max(200)).max(200).optional(),
  service: z.string().max(40).nullable().optional(),
  sent_at: z.string().datetime({ offset: true }),
  is_from_me: z.boolean(),
  /** The sender's handle; null or absent for Ben's own messages. */
  handle: z.string().max(200).nullable().optional(),
  /** The sender's name as the collector knows it (optional; contacts are not read by default). */
  handle_name: z.string().max(200).nullable().optional(),
  text: z.string().max(100_000).nullable().optional(),
  attachments: z.array(attachment).max(50).optional(),
});

export const ingestBatchSchema = z.object({
  collector: z.object({ name: z.string().max(100).optional(), version: z.string().max(40).optional(), host: z.string().max(200).optional() }).optional(),
  /** What the collector skipped before sending (counts only), recorded in import_runs. */
  collector_counts: z.record(z.string().max(60), z.number().int().min(0)).optional(),
  messages: z.array(ingestMessageSchema).max(MAX_BATCH_MESSAGES),
});

export type IngestMessage = z.infer<typeof ingestMessageSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export function imessageSourceRef(chatGuid: string, day: string): string {
  return `imessage:${chatGuid}:${day}`;
}

/** Groups a batch into per-conversation, per-local-day threads. */
export function imessageThreads(batch: IngestBatch): ThreadInput[] {
  const threads = new Map<string, ThreadInput>();
  for (const m of batch.messages) {
    const sentAt = new Date(m.sent_at);
    const day = localDay(sentAt);
    const ref = imessageSourceRef(m.chat_guid, day);
    let t = threads.get(ref);
    if (!t) {
      const names = m.chat_name?.trim();
      t = {
        source: "imessage",
        kind: "text_thread",
        sourceRef: ref,
        title: null,
        participants: (m.chat_participants ?? []).map((identifier) => ({ identifier })),
        messages: [],
        meta: { chat_guid: m.chat_guid, local_date: day, service: m.service ?? null, chat_name: names || null },
      };
      threads.set(ref, t);
    }
    if (!m.is_from_me && m.handle && m.handle_name) {
      const p = t.participants!.find((x) => x.identifier === m.handle);
      if (p && !p.name) p.name = m.handle_name;
    }
    t.messages.push({
      id: m.guid,
      sentAt,
      fromMe: m.is_from_me,
      from: m.is_from_me ? null : m.handle ?? null,
      fromName: m.is_from_me ? null : m.handle_name ?? null,
      to: m.is_from_me ? m.chat_participants ?? [] : [],
      text: m.text ?? "",
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename ?? null, mime: a.mime ?? null, size: a.size ?? null })),
    });
  }
  return [...threads.values()];
}

