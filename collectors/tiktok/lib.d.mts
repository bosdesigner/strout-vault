// Types for lib.mjs, so the vault's TypeScript tests can import the collector's pure functions.
export interface ScreenMessage {
  time_label: string | null;
  from_me: boolean;
  text: string;
  shared_url?: string | null;
  attachments?: Array<{ filename: string | null; mime: string | null; size: number | null }>;
}
export interface ConvState {
  ordinal: number;
  seen: string[];
  username: string;
  updated_at: string;
}
export interface ListRow {
  index: number;
  nickname: string | null;
  preview: string | null;
  time_label: string | null;
  unread: boolean;
  avatar: string;
}
export interface BatchMessage {
  id: string;
  sent_at: string;
  from_me: boolean;
  text: string;
  shared_url?: string;
  attachments?: ScreenMessage["attachments"];
}
export function defaultPaths(home?: string): { dir: string; token: string; state: string; profile: string; selectors: string; failures: string };
export function parseTikTokTime(label: string | null | undefined, now?: Date): Date | null;
export function digest(...parts: unknown[]): string;
export function fingerprint(m: ScreenMessage): string;
export function newMessages(onScreen: ScreenMessage[], seen: string[]): { fresh: Array<{ m: ScreenMessage; fp: string }>; aligned: boolean };
export function readState(file: string): { version: number; conversations: Record<string, ConvState>; rows: Record<string, { previewDigest: string; conv: string; at: string }>; last_run?: string };
export function writeState(file: string, state: unknown): void;
export function buildConversation(
  conv: { key: string; username: string; nickname?: string | null; messages: ScreenMessage[]; is_request?: boolean },
  prev: ConvState | undefined,
  now?: Date,
): {
  entry: { conversation_id: string; peer: { username: string; display_name: string | null }; is_request?: boolean; messages: BatchMessage[] } | null;
  next: ConvState;
  aligned: boolean;
};
export function conversationKey(username: string): string;
export function rowState(row: ListRow, convKey: string, now?: Date): { previewDigest: string; conv: string; at: string };
export function listRowChanged(row: ListRow, prev: { previewDigest: string } | undefined): boolean;
