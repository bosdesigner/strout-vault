// A Gmail API thread (format=full) as a ThreadInput: plain-text body only, quoted replies and
// signatures stripped with email-reply-parser, subject as the title, attachments as metadata
// (filename, mime, size) and never their bytes. Filtering happens in the shared ingest.
import EmailReplyParser from "email-reply-parser";
import type { MessageAttachment, MessageInput, ThreadInput } from "../ingest.ts";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

export function gmailSourceRef(account: string, threadId: string): string {
  return `gmail:${account.toLowerCase()}:${threadId}`;
}

export function header(part: GmailPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** "Kevin McGuire <kevin@x.com>" -> { name, email }. */
export function parseAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1]?.trim() || null, email: m[2].trim() };
  return { name: null, email: raw.trim() };
}

/** Splits an address list on commas that are not inside quotes or angle brackets. */
export function parseAddressList(raw: string | null): Array<{ name: string | null; email: string | null }> {
  if (!raw) return [];
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      out.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map(parseAddress).filter((a) => a.email);
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/** The first text/plain part that is not an attachment, depth first. */
export function plainTextPart(part: GmailPart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && !part.filename && part.body?.data) return decodeBody(part.body.data);
  for (const p of part.parts ?? []) {
    const t = plainTextPart(p);
    if (t !== null) return t;
  }
  return null;
}

export function attachments(part: GmailPart | undefined, out: MessageAttachment[] = []): MessageAttachment[] {
  if (!part) return out;
  if (part.filename) out.push({ filename: part.filename, mime: part.mimeType ?? null, size: part.body?.size ?? null });
  for (const p of part.parts ?? []) attachments(p, out);
  return out;
}

const parser = new EmailReplyParser();

/** The new text of one email: plain-text part, quotes and signature removed. */
export function visibleBody(plain: string | null): string {
  if (!plain) return "";
  return parser.read(plain.replace(/\r\n/g, "\n")).getVisibleText().trim();
}

export function gmailMessageInput(m: GmailMessage): MessageInput {
  const from = parseAddress(header(m.payload, "From"));
  const to = [...parseAddressList(header(m.payload, "To")), ...parseAddressList(header(m.payload, "Cc"))].map((a) => a.email!);
  const date = m.internalDate ? new Date(Number(m.internalDate)) : new Date(header(m.payload, "Date") ?? Date.now());
  return {
    id: m.id,
    sentAt: date,
    fromMe: (m.labelIds ?? []).includes("SENT"),
    from: from.email,
    fromName: from.name,
    to,
    text: visibleBody(plainTextPart(m.payload)),
    attachments: attachments(m.payload),
    labels: m.labelIds ?? [],
    listUnsubscribe: !!header(m.payload, "List-Unsubscribe"),
  };
}

export function gmailThreadInput(account: string, t: GmailThread): ThreadInput {
  const messages = (t.messages ?? []).map(gmailMessageInput);
  const first = t.messages?.[0];
  const subject = header(first?.payload, "Subject")?.trim() || "(no subject)";
  return {
    source: "gmail",
    kind: "email_thread",
    sourceRef: gmailSourceRef(account, t.id),
    title: subject,
    messages,
    meta: { account: account.toLowerCase(), thread_id: t.id, history_id: t.historyId ?? null },
  };
}
