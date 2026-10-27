// The worker's meet step: new Google Meet recordings (and their transcript Docs) from every
// connected Meet account, archived and queued for transcription. See server/meet/sync.ts.
import type { WorkerContext } from "./context.ts";
import { syncMeet, type MeetSyncSummary } from "../meet/sync.ts";

export async function processMeet(ctx: WorkerContext, opts: { dryRun?: boolean } = {}): Promise<MeetSyncSummary> {
  const summary = await syncMeet(ctx, opts);
  if (summary.skipped) ctx.log(`meet: skipped (${summary.skipped})`);
  return summary;
}
