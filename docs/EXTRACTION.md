# Extraction (Jarvis step 2)

Step 1 gave agents a way to read the vault ([MCP.md](MCP.md)). Step 2 fills in what they read:
the hourly worker reads each filed recording once with Claude and proposes what the relationship
graph should learn from it. Every proposal goes to the **Review** page. Nothing reaches `facts`,
`interaction_participants` or `interaction_links` until Ben approves it.

## What gets proposed

| Proposal (`review_queue.item_type`) | From the transcript | Approving it writes |
|---|---|---|
| `new_fact` | a commitment, follow-up, decision, price, issue or preference, as one plain sentence with its owner, the person it is about, the project, an amount and a due date when stated, and the line it came from | a `facts` row (`status = 'open'`, `source_review_id` = the review item) |
| `link_party_interaction` | an unmatched speaker label that is clearly a known person | `interaction_participants`, plus `segments.speaker_party_id` for that label's lines |
| `link_project_interaction` | a known project the call is substantially about | `interaction_links` |

These are the same shapes the MCP `propose_update` tool uses, and approving goes through one code path
(`server/services/review.ts`). That path now also applies the agent-only types `new_party` (with its
workspace role), `party_edit` (emails and phones are added, never replaced), and `new_relationship`
(a repeat adds evidence to the existing edge). An item that no longer applies, such as a deleted party
or a shape that fails validation, is refused with a 400 and stays open.

Approved commitments and follow-ups show up in the MCP `list_open_commitments` tool straight away.

## Guardrails

- **Only filed recordings.** A recording without a workspace is never read. `EXTRACT_WORKSPACES`
  defaults to `*`, which is every workspace except **phalanx**. Phalanx is read only when listed
  (`*,phalanx`), the same rule as token scopes.
- **Only known ids.** Claude gets the recording's participants, people with a role in its workspace
  (150 at most) and the workspace's projects (100 at most). Any id it returns that was not on those
  lists is dropped, and so is a speaker match to a label that is not in the recording, a label that is
  already matched, or a person already on the recording.
- **Only real moments.** A fact whose timestamp falls outside the chunk it came from is dropped, and
  so is a due date that is not a date. Proposals under `EXTRACT_MIN_CONFIDENCE` (0.6) are dropped too.
- **Never twice.** `interactions.extracted_at` marks a recording as read. If it is read again, nothing
  is queued that this recording already has in `review_queue` (open, approved **or rejected**) or in `facts`.
- **The transcript is data.** The system prompt says so, the same as the MCP tool descriptions.
- **Money.** Nothing is sent without `ANTHROPIC_API_KEY` **and** `EXTRACT_MONTHLY_BUDGET_USD > 0`.
  The budget is checked against `spend_ledger` (`provider = 'anthropic-extract'`, separate from the
  scout's `anthropic`) before each recording. The actual usage is recorded even when a later chunk fails.
  A recording that would go over budget gets `extract_error = 'waiting: …'` and the step stops for the month.

## Model and cost

`claude-opus-5-5` at `medium` effort with structured output (Zod schema) and the server-side refusal
fallback, the same call shape as the clip scout. Transcripts go in 25-minute chunks, each with the
recording's context block, and the system prompt is cached.

Rough cost on Opus 5.5 is about **8 cents per hour of conversation**. Most of that is input, plus
the thinking the model does at medium effort. The backlog of roughly 630 filed recordings comes to
about **$40–60** once. After that it is a few dollars a month. `EXTRACT_MAX_PER_RUN` (20) caps each
hourly run, so the backlog drains over a day or two at most.

## Turning it on

1. Apply `db/migrations/0007_extract.sql` in the Neon SQL Editor (branch `main`, database `neondb`,
   role `neondb_owner`), then check that `select change from schema_log order by id desc limit 1;`
   starts with `v0.7 extract:`.
2. Pull and redeploy **both** Repls. The web app has the new Review and Pipeline cards; the worker has the step.
3. Add `EXTRACT_MONTHLY_BUDGET_USD` to the worker's secrets. Start small, e.g. `5`. `ANTHROPIC_API_KEY`
   is the one the scout already uses.
4. Run three recordings by hand in the worker Shell, then read what they queued on **Review**:

   ```bash
   EXTRACT_MAX_PER_RUN=3 npm run worker:dev -- --steps extract
   ```

5. If the proposals read right, raise the budget. The hourly run takes it from there, 20 recordings at a time.

The **Pipeline** page shows recordings read and waiting, failures, open proposals, and the month's spend
against the budget.

## Settings

| Secret (worker) | Default | |
|---|---|---|
| `EXTRACT_MONTHLY_BUDGET_USD` | `0` (off) | monthly ceiling, enforced from `spend_ledger` |
| `EXTRACT_MODEL` | `claude-opus-5-5` | |
| `EXTRACT_EFFORT` | `medium` | `low` … `max` |
| `EXTRACT_WORKSPACES` | `*` | comma list; `*` excludes phalanx unless it is listed |
| `EXTRACT_MAX_PER_RUN` | `20` | recordings per hourly run |
| `EXTRACT_MIN_CONFIDENCE` | `0.6` | proposals below this are not queued |

## Code map

```
server/worker/extract.ts      prompt, schema, context block, guardrails (toProposals, dedupeProposals), the step
server/services/review.ts     APPLIERS: what approving each proposal type writes
server/worker/report.ts       extraction counts and spend for the Pipeline page
db/migrations/0007_extract.sql
tests/api/extract.test.ts     the step against a mock Claude, and every applier
tests/unit/extract.test.ts    guardrails and dedupe
```

## Not in this step

Creating new people from a transcript (only known parties are referenced; agents can still propose
`new_party`), marking facts done, and the action tools (Gmail drafts, calendar, AnotherStoryBLDR
writes) come later.
