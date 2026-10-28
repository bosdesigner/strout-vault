// Types for page.mjs (the in-page readers), for the vault's TypeScript tests.
import type { ListRow, ScreenMessage } from "./lib.mjs";
export const DEFAULT_SELECTORS: Record<string, string>;
export function readList(sel: Record<string, string>): ListRow[];
export function readConversation(sel: Record<string, string>, account: string): { username: string; nickname: string | null; messages: ScreenMessage[]; itemCount: number };
export function probePage(sel: Record<string, string>): { url: string; counts: Record<string, number | string>; dataE2e: string[]; skeleton: unknown };
