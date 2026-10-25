# Extraction + applying approvals: verification

What was checked for Jarvis step 2 ([EXTRACTION.md](EXTRACTION.md)). Everything ran against a local
Postgres 16 with pgvector, the seeded database (`db/seed.sql`, all seven migrations) and a mock Claude
(`tests/mocks/zoomGroq.ts`). Nothing touched Neon, Anthropic or R2.

- `npm run typecheck`: clean (server and client).
- `npx vitest run`: 24 files, **218 tests passed** (200 before this step).
  - `tests/api/extract.test.ts` (13): off without a budget; reads the newest filed recordings with
    effort, structured output, cached system prompt and the refusal fallback; drops invented timestamps,
    unknown ids, unknown labels and low-confidence items; records spend under `anthropic-extract` only;
    never re-reads, and a re-read does not bring back a rejected item; stops at the budget; phalanx only
    when listed; a refusal reads as empty. Approving applies `new_fact` (with `source_review_id`),
    `link_party_interaction` (participant + speaker lines), `link_project_interaction` (once),
    `new_party` + role, `party_edit` (emails merged), `new_relationship` (evidence +1 on repeat).
    An item that no longer applies gets a 400 and stays open.
  - `tests/unit/extract.test.ts` (5): guardrails, dedupe, context block, text normalisation.
- `npx playwright test tests/e2e/phase2.spec.ts`: **11 passed**. The Review page's keyboard
  approve/reject flow is unchanged.

Not checked here: a real Claude response on production transcripts. That is the first manual run in
EXTRACTION.md, step 4.
