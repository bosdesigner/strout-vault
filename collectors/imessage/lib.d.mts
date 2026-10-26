// Types for lib.mjs, so the vault's TypeScript tests can import the collector's pure functions.
/** The slice of node:sqlite's DatabaseSync the collector uses (typed here so Node 20 type definitions suffice). */
export interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  setReadBigInts(enabled: boolean): void;
}
export interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
export function loadSqlite(): { DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => DatabaseSync };

export const APPLE_EPOCH_OFFSET_SEC: number;
export function appleTimeToDate(value: number | bigint | null | undefined): Date | null;
export function dateToAppleNanos(date: Date): bigint;
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null;
export function isShortCode(handle: string | null | undefined): boolean;
export function isOneTimeCode(text: string | null | undefined): boolean;
export interface ChatDbCopy {
  db: DatabaseSync;
  dir: string;
}
export function openChatDbCopy(source: string): ChatDbCopy;
export function closeCopy(copy: ChatDbCopy): void;
export interface CollectedMessage {
  guid: string;
  chat_guid: string;
  chat_name: string | null;
  chat_participants: string[];
  service: string | null;
  sent_at: string;
  is_from_me: boolean;
  handle: string | null;
  text: string;
  attachments: Array<{ filename: string | null; mime: string | null; size: number | null }>;
}
export interface ReadRow {
  rowid: number;
  skip: "reaction" | "system" | "short_code" | "one_time_code" | "empty" | "no_date" | null;
  chatLabel: string;
  message: CollectedMessage | null;
}
export function readMessages(db: DatabaseSync, afterRowId: number, limit: number): ReadRow[];
export function defaultPaths(home?: string): { chatDb: string; state: string; token: string };
export function readState(file: string): { lastRowId: number };
export function writeState(file: string, lastRowId: number): void;
