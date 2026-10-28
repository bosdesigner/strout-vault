// TikTok and Instagram direct messages, whichever reader produced them (the TikTok collector on
// Ben's Mac POSTs a batch to /api/ingest/social; the Instagram worker step builds the same batch
// from the official API), and how a batch becomes threads: one text_thread per conversation per
// local calendar day in America/Chicago, like iMessage, with
//
//   source       "tiktok" | "instagram"
//   source_ref   "<platform>:<account>:<conversation_id>:<YYYY-MM-DD>"   (account = Ben's username)
//   identifiers  "<platform>:<username>" for the other person; Ben's own messages are from_me
//
// Batches may split a day; the ingest merges them by message id. Everything after grouping
// (filter, redact, match by handle, route, write) is server/messages/ingest.ts.
import { z } from "zod";
import { normalizeHandle, SOCIAL_PLATFORMS, type SocialPlatform } from "./identity.ts";
import { localDay, type ThreadInput } from "./ingest.ts";

export const MAX_SOCIAL_MESSAGES = 2000;

const attachment = z.object({
  filename: z.string().max(500).nullable().optional(),
  mime: z.string().max(200).nullable().optional(),
  size: z.coerce.number().int().min(0).nullable().optional(),
});

const username = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.replace(/^@/, "").toLowerCase())
  .refine((v) => /^[a-z0-9._]{1,64}$/.test(v), "not a TikTok/Instagram username");

export const socialMessageSchema = z.object({
  /** Stable per platform: TikTok's message id (or the collector's stable hash), Instagram's mid. */
  id: z.string().min(1).max(300),
  sent_at: z.string().datetime({ offset: true }),
  from_me: z.boolean(),
  text: z.string().max(100_000).nullable().optional(),
  attachments: z.array(attachment).max(50).optional(),
  /** A shared video/post/story, kept as a link in the message text when there is no other text. */
  shared_url: z.string().url().max(2000).nullable().optional(),
});

export const socialConversationSchema = z.object({
  /** The platform's conversation id, or the peer's username when the reader has nothing better. */
  conversation_id: z.string().min(1).max(300),
  peer: z.object({
    username,
    display_name: z.string().max(200).nullable().optional(),
    /** Instagram-scoped id (IGSID) or TikTok user id, when known. Kept in source_payload. */
    platform_id: z.string().max(200).nullable().optional(),
  }),
  /** Message requests (TikTok "Requests", Instagram "Requests" folder) as opposed to the main inbox. */
  is_request: z.boolean().optional(),
  messages: z.array(socialMessageSchema).max(MAX_SOCIAL_MESSAGES),
});

export const socialBatchSchema = z.object({
  platform: z.enum(SOCIAL_PLATFORMS),
  /** Ben's own username on that platform: the account whose inbox this is. */
  account: username,
  collector: z.object({ name: z.string().max(100).optional(), version: z.string().max(40).optional(), host: z.string().max(200).optional() }).optional(),
  /** What the reader skipped before sending (counts only), recorded in import_runs. */
  collector_counts: z.record(z.string().max(60), z.number().int().min(0)).optional(),
  conversations: z.array(socialConversationSchema).max(500),
});

export type SocialMessage = z.infer<typeof socialMessageSchema>;
export type SocialConversation = z.infer<typeof socialConversationSchema>;
export type SocialBatch = z.infer<typeof socialBatchSchema>;
export type SocialBatchInput = z.input<typeof socialBatchSchema>;

export function socialSourceRef(platform: SocialPlatform, account: string, conversationId: string, day: string): string {
  return `${platform}:${account}:${conversationId}:${day}`;
}

/** Total messages in a batch (the per-request cap applies across conversations). */
export function socialMessageCount(batch: Pick<SocialBatch, "conversations">): number {
  return batch.conversations.reduce((n, c) => n + c.messages.length, 0);
}

/** Groups a batch into per-conversation, per-local-day threads. */
export function socialThreads(batch: SocialBatch): ThreadInput[] {
  const threads = new Map<string, ThreadInput>();
  const me = normalizeHandle(batch.platform, batch.account)!;
  for (const conv of batch.conversations) {
    const peer = normalizeHandle(batch.platform, conv.peer.username);
    if (!peer || peer === me) continue;
    const name = conv.peer.display_name?.trim() || null;
    for (const m of conv.messages) {
      const sentAt = new Date(m.sent_at);
      const day = localDay(sentAt);
      const ref = socialSourceRef(batch.platform, batch.account, conv.conversation_id, day);
      let t = threads.get(ref);
      if (!t) {
        t = {
          source: batch.platform,
          kind: "text_thread",
          sourceRef: ref,
          title: null,
          participants: [{ identifier: peer, name }],
          messages: [],
          meta: {
            platform: batch.platform,
            account: batch.account,
            conversation_id: conv.conversation_id,
            peer_username: conv.peer.username,
            peer_platform_id: conv.peer.platform_id ?? null,
            local_date: day,
            ...(conv.is_request ? { is_request: true } : {}),
          },
        };
        threads.set(ref, t);
      }
      const text = (m.text ?? "").trim() || (m.shared_url ? `[shared: ${m.shared_url}]` : "");
      t.messages.push({
        id: `${batch.platform}:${m.id}`,
        sentAt,
        fromMe: m.from_me,
        from: m.from_me ? null : peer,
        fromName: m.from_me ? null : name,
        to: m.from_me ? [peer] : [],
        text,
        attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename ?? null, mime: a.mime ?? null, size: a.size ?? null })),
      });
    }
  }
  return [...threads.values()];
}
