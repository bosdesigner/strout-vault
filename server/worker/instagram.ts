// The worker's instagram step: one incremental pass (new DMs since the last pass) over every
// connected Instagram professional account. See server/messages/instagram/sync.ts and docs/SOCIAL_DMS.md.
import type { WorkerContext } from "./context.ts";
import { syncInstagram, type InstagramSyncSummary } from "../messages/instagram/sync.ts";

export async function processInstagram(ctx: WorkerContext, opts: { dryRun?: boolean } = {}): Promise<InstagramSyncSummary> {
  const summary = await syncInstagram({ pool: ctx.pool, config: ctx.config, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, now: ctx.now, log: ctx.log, deadline: ctx.deadline }, opts);
  if (summary.skipped) ctx.log(`instagram: skipped (${summary.skipped})`);
  return summary;
}
