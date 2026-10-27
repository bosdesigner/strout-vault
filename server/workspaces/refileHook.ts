// Runs the Inbox refile after a change that can make people known (an approved person, a new role
// or company link). Never fails the request it follows: errors are logged, counts only.
import type { AppContext } from "../context.ts";
import { ownerIdentity } from "../messages/identity.ts";
import { loadMessageRules } from "../messages/rules.ts";
import { refileInbox, type RefileSummary } from "./refile.ts";

export async function refileAfterChange(ctx: AppContext, partyIds?: number[]): Promise<RefileSummary | null> {
  try {
    return await refileInbox(ctx.pool, loadMessageRules(ctx.config.MESSAGES_CONFIG_DIR), ownerIdentity(ctx.config), { partyIds });
  } catch (err) {
    console.error(`[refile] ${(err as Error).message.slice(0, 200)}`);
    return null;
  }
}
