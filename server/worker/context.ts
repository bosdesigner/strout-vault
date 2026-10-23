import type pg from "pg";
import type { Config } from "../config.ts";
import type { StorageDriver } from "../storage/types.ts";
import type { MediaTools } from "./media.ts";

/** Everything a worker run needs. Tests inject fetch, sleep and the clock. */
export interface WorkerContext {
  config: Config;
  pool: pg.Pool;
  storage: StorageDriver;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  /** Scratch directory for downloads being transcoded; cleaned per item. */
  tmpDir: string;
  tools: MediaTools;
  /** Epoch ms after which no new work item is started. */
  deadline: number;
  /** Bytes this run may still download from Zoom. */
  bytesBudget: number;
}

export function outOfTime(ctx: WorkerContext): boolean {
  return ctx.now().getTime() >= ctx.deadline;
}

/** Errors that stop one item but not the run. */
export class ItemError extends Error {}
