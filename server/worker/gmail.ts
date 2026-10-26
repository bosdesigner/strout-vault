// The worker's gmail step: an incremental pass (history.list) over every connected account.
// Backfills are not run here; Ben runs them by hand (npm run messages:gmail). See docs/MESSAGES.md.
import type { WorkerContext } from "./context.ts";
import { syncGmail, type GmailSyncSummary } from "../messages/gmail/sync.ts";

export async function processGmail(ctx: WorkerContext, opts: { dryRun?: boolean } = {}): Promise<GmailSyncSummary> {
  const summary = await syncGmail({ pool: ctx.pool, config: ctx.config, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, now: ctx.now, log: ctx.log, deadline: ctx.deadline }, opts);
  if (summary.skipped) ctx.log(`gmail: skipped (${summary.skipped})`);
  return summary;
}
