// Types for lib.mjs, so the vault's TypeScript tests can import the collector's pure functions.
export interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
export function loadSqlite(): { DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => DatabaseSync };

export const APPLE_EPOCH_OFFSET_SEC: number;
export function coreDataDate(value: unknown): Date | null;
export function toCoreData(date: Date): number;
export class SchemaError extends Error {}
export class AccessError extends Error {}
export const FULL_DISK_ACCESS_HELP: string;

export interface ApplePaths {
  voiceMemosDirs: string[];
  notesDir: string;
  state: string;
  config: string;
  log: string;
}
export function defaultPaths(home?: string): ApplePaths;

export interface CollectorConfig {
  include_voice_memos: boolean;
  include_call_recordings: boolean;
  include_notes: boolean;
  skip_folders: string[];
  allow_folders: string[] | null;
  call_recordings_folder: string;
  call_title_detection: boolean;
  min_note_chars: number;
  min_memo_seconds: number;
}
export const DEFAULT_CONFIG: CollectorConfig;
export function loadConfig(file: string | null): CollectorConfig;
export function canRead(dir: string): boolean;

export interface DbCopy {
  db: DatabaseSync;
  dir: string;
}
export function openCopy(source: string): DbCopy;
export function closeCopy(copy: DbCopy): void;
export function tables(db: DatabaseSync): string[];
export function columns(db: DatabaseSync, table: string): string[];

export interface VoiceMemo {
  uniqueId: string;
  title: string | null;
  recordedAt: Date | null;
  durationSec: number;
  file: string | null;
  bytes: number | null;
  skip: "deleted" | "short" | "not_downloaded" | null;
}
export function findVoiceMemosDir(dirs: string[]): string | null;
export function readVoiceMemos(db: DatabaseSync, recordingsDir: string, cfg?: CollectorConfig): VoiceMemo[];

export function protoFields(buf: Buffer): Array<{ field: number; wire: number; value: Buffer | bigint }>;
export function decodeNoteBody(blob: Uint8Array | null | undefined): string | null;
export function encodeNoteBody(text: string): Buffer;

export interface TextNote {
  id: string;
  title: string | null;
  folder: string | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
  text: string | null;
  skip: "locked" | "deleted" | "folder_skipped" | "folder_not_allowed" | "short" | "empty" | null;
}
export interface CallRecording {
  ref: string;
  noteId: string;
  attachmentId: string;
  title: string | null;
  folder: string | null;
  createdAt: Date | null;
  durationSec: number | null;
  file: string | null;
  bytes: number | null;
  participant: { name: string | null; phone: string | null } | null;
  appleTranscript: string | null;
  skip: "locked" | "deleted" | "not_downloaded" | null;
}
export function readNotes(db: DatabaseSync, notesDir: string, cfg?: CollectorConfig): { notes: TextNote[]; recordings: CallRecording[]; otherAudio: number; folders: string[] };
export const CALL_TITLE: RegExp;
export function participantFromTitle(title: string | null): { name: string | null; phone: string | null } | null;
export function findMediaFile(notesDir: string, accountId: string | null, mediaId: string | null, filename: string | null): string | null;
export function discover(paths?: ApplePaths): string;
export function countBy(list: string[]): Record<string, number>;
export function fmtCounts(obj: Record<string, number>): string;
export function sha256File(file: string): Promise<string>;
export function readState(file: string): Record<"voice_memo" | "iphone_call" | "apple_note", Record<string, string>> & { started_at: string | null };
export function writeState(file: string, state: Record<string, unknown>): void;
export function readToken(opts?: { service?: string; account?: string }): string;
export function makeLogger(file: string | null, opts?: { maxBytes?: number; keep?: number; echo?: boolean }): (line: string) => void;
