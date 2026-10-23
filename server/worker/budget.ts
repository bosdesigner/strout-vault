// Monthly spend ceilings for paid APIs, enforced from the ledger rather than
// from memory. The rule from the build prompt: never spend money without the
// owner saying so. A budget of 0 (the default) means the provider is off.

import type pg from "pg";

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthToDateSpend(pool: pg.Pool, provider: string, now: Date): Promise<number> {
  const { rows } = await pool.query(`select coalesce(sum(usd), 0)::float8 as usd from spend_ledger where provider = $1 and created_at >= $2`, [
    provider,
    monthStartUtc(now),
  ]);
  return Number(rows[0]?.usd ?? 0);
}

export interface BudgetCheck {
  allowed: boolean;
  spent: number;
  budget: number;
  estimate: number;
  reason?: string;
}

/** Whether an estimated charge fits under this month's budget. */
export async function checkBudget(pool: pg.Pool, provider: string, budgetUsd: number, estimateUsd: number, now: Date): Promise<BudgetCheck> {
  if (!(budgetUsd > 0)) return { allowed: false, spent: 0, budget: budgetUsd, estimate: estimateUsd, reason: `${provider} is off: set its monthly budget to enable it` };
  const spent = await monthToDateSpend(pool, provider, now);
  if (spent + estimateUsd > budgetUsd) {
    return {
      allowed: false,
      spent,
      budget: budgetUsd,
      estimate: estimateUsd,
      reason: `${provider} monthly budget reached ($${spent.toFixed(2)} spent + $${estimateUsd.toFixed(2)} estimated > $${budgetUsd.toFixed(2)})`,
    };
  }
  return { allowed: true, spent, budget: budgetUsd, estimate: estimateUsd };
}

export async function recordSpend(
  pool: pg.Pool,
  entry: { provider: string; model: string | null; interactionId: number | null; unitsSec: number | null; usd: number; note?: string | null },
): Promise<void> {
  await pool.query(`insert into spend_ledger (provider, model, interaction_id, units_sec, usd, note) values ($1, $2, $3, $4, $5, $6)`, [
    entry.provider,
    entry.model,
    entry.interactionId,
    entry.unitsSec,
    entry.usd,
    entry.note ?? null,
  ]);
}
