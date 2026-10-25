// The worker's leads step: read every configured source, then mirror (server/leads/sync.ts).
// A source that fails to read is reported and skipped; the others still sync.

import type { WorkerContext } from "./context.ts";
import { readAirtableLeads, readPlatformLeads, type LeadInput } from "../leads/sources.ts";
import { emptySummary, syncLeads, type LeadSyncSummary } from "../leads/sync.ts";

export function leadsConfigured(ctx: WorkerContext): boolean {
  return !!(ctx.config.LEADS_DATABASE_URL || ctx.config.AIRTABLE_TOKEN);
}

export async function readLeadSources(ctx: WorkerContext, summary: LeadSyncSummary): Promise<LeadInput[]> {
  const c = ctx.config;
  const inputs: LeadInput[] = [];
  const read = async (name: string, configured: boolean, fn: () => Promise<LeadInput[]>) => {
    summary.sources[name] = { configured, read: 0 };
    if (!configured) return;
    try {
      const rows = await fn();
      summary.sources[name].read = rows.length;
      inputs.push(...rows);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      summary.sources[name].error = msg;
      summary.errors.push(`${name}: ${msg}`);
      ctx.log(`leads: ${name} could not be read: ${msg}`);
    }
  };
  await read("platform", !!c.LEADS_DATABASE_URL, () => readPlatformLeads(c.LEADS_DATABASE_URL!));
  await read("airtable", !!c.AIRTABLE_TOKEN, () => readAirtableLeads({ token: c.AIRTABLE_TOKEN!, baseId: c.AIRTABLE_BASE_ID, apiUrl: c.AIRTABLE_API_URL, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep }));
  return inputs;
}

export async function processLeads(ctx: WorkerContext, opts: { dryRun?: boolean } = {}): Promise<LeadSyncSummary> {
  const summary = emptySummary(!!opts.dryRun);
  if (!leadsConfigured(ctx)) {
    ctx.log("leads: skipped (neither LEADS_DATABASE_URL nor AIRTABLE_TOKEN is set)");
    return summary;
  }
  const inputs = await readLeadSources(ctx, summary);
  return syncLeads(ctx.pool, inputs, { workspaceId: ctx.config.LEADS_WORKSPACE, dryRun: opts.dryRun, log: ctx.log }, summary);
}
