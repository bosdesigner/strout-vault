# Semantic search quality check

Run with `npm run mcp:semantic-check` on 2026-10-24 against the seeded local database
(`db/seed.sql`), provider **fake fake-hash-1024** (1024 dimensions), 827 chunks.

Each query paraphrases a passage that appears in exactly one seeded recording and shares no
keywords with it (the passages are listed under DISTINCTIVE in `scripts/gen-seed.ts`). The
check calls `search_conversations` in semantic mode with limit 3 and looks for the expected
recording in the results.

**Result: 1/5 queries ranked the right recording in the top 3.**

| Result | Query | Expected recording | Rank | Top 3 returned |
|---|---|---|---|---|
| pass | investor asking for governance perks and a lower valuation before committing | Harbor Point seed terms | 1 | Harbor Point seed terms · Charleston green paint sample · Oakridge framing walkthrough |
| MISS | keeping the trial engagement small enough that the customer can sign off quickly | Phalanx pilot scope with Daniel | not in top 3 | Harbor Point seed terms · SOC 2 readiness planning · CredVault pipeline review |
| MISS | lumber availability problem forcing a material change or a schedule delay | Gulf Coast Millwork stock check | not in top 3 | Rough cut review with Sam · Permit status with Bayou City · Mudroom layout with Maria |
| MISS | dawn aerial footage then a sit-down conversation with the person who started the company | Conroe shoot day planning | not in top 3 | SEPP grant application strategy · Color pass sign-off · IMG_5310 |
| MISS | deadline for public energy funding and the local government endorsement it needs | SEPP grant application strategy | not in top 3 | Bennett lake house kickoff · Zoom Meeting · Mudroom layout with Maria |

> The fake provider hashes words, so paraphrases without shared vocabulary cannot match: misses are expected here. Re-run with `EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=…` (or openai) for the real check; the table above is then overwritten.

Passages targeted:

- **Harbor Point seed terms**: "board observer seat … pro rata right … pushed the pre-money down"
- **Phalanx pilot scope with Daniel**: "cap the pilot at one site and ninety days … approve it without waiting for a budget cycle"
- **Gulf Coast Millwork stock check**: "cypress on the floor today but the cedar is three weeks out … switch species or push the install"
- **Conroe shoot day planning**: "shoot at sunrise so the drone pass clears … founder interview on the shop floor"
- **SEPP grant application strategy**: "state efficiency grant closes in March … county letter of support"
