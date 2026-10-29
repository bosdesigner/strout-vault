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

- **Only filed recordings, or ones the classifier files confidently.** A recording without a workspace
  is read only when the workspace classifier puts it in one at 0.85 or more (step 5 B, below).
  `EXTRACT_WORKSPACES` defaults to `*`, which is every workspace except **phalanx**, **personal** and
  **inbox**. Phalanx is read only when listed (`*,phalanx`), the same rule as token scopes.
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
| `EXTRACT_WORKSPACES` | `*` | comma list; `*` excludes phalanx (unless listed), personal and inbox |
| `EXTRACT_MAX_PER_RUN` | `20` | recordings per hourly run (filed and unfiled together) |
| `EXTRACT_THREAD_DAYS` | `30` | texts and email with a message in the last N days are read; `0` = threads off |
| `EXTRACT_THREADS_PER_RUN` | `50` | threads per hourly run |
| `EXTRACT_UNFILED` | `1` | `0` = unfiled recordings are never read |
| `EXTRACT_MIN_CONFIDENCE` | `0.6` | proposals below this are not queued |

## Texts, email and unfiled recordings (Jarvis step 5 B)

Step 5 ([FOLLOW-THROUGH.md](FOLLOW-THROUGH.md)) needs the vault to notice what Ben promised in texts and
email, and in the sales calls that land unfiled. The same step, prompt, guardrails, budget and Review
queue now cover both.

**Texts and email.** A `text_thread` or `email_thread` in a readable workspace is read when its last
message is within `EXTRACT_THREAD_DAYS` (30). Each message is one line (sender, then text, stamped with
the time since the thread's first message), sent in pieces of about 20,000 characters.
`interactions.extracted_through_idx` remembers the last message read. When a thread gains messages, it
is read again and **only the new messages are sent**; the last six messages already read and what is
already recorded from the thread (facts and open or approved proposals) go along as context, marked as
context, so the new messages make sense and nothing is proposed twice. The duplicate check against
`review_queue` and `facts` still applies on top. Threads come first in each run, since they are what
is waiting on a reply.

Cost: a thread's own text is short, but every request carries the context block (up to 150 people
and 100 projects) and the model's thinking, so a read is roughly **2–5 cents** on Opus 5.5 at medium
effort, whether the thread has two messages or twenty. The first runs work through the last 30 days of
threads; after that the cost follows how many threads get new messages each day. The monthly budget
caps all of it, and the spend shows on the Pipeline page. `EXTRACT_THREAD_DAYS` shortens the first
pass, and `EXTRACT_THREADS_PER_RUN` slows it.

**Unfiled recordings.** Zoom calls often land without a workspace (the assessment calls are titled
"NAME: AnotherStory Assessment" and have no known participants yet). Each run, the worker classifies
up to 200 unread unfiled recordings with the same classifier as `npm run propose:workspaces`
(`server/workspaces/classify.ts`). One it files at **0.85 or more** (a title rule, or a known person's
full name in the title) into a workspace this run may read is read **under that workspace**, and the
filing is queued on Review as an `interaction_workspace` item (unless one is already open). Reading
never files anything: approving that item does. A recording whose filing Ben rejected is not read, and
phalanx is never guessed into unless `EXTRACT_WORKSPACES` lists it. Facts approved from it carry the
classifier's workspace.

**Turning it on.** Apply `db/migrations/0011_extract_threads.sql` (after 0010) the same way as 0007,
check `/api/health` reports `v0.11`, and redeploy the worker. Nothing else is needed: threads and
unfiled recordings are read whenever `EXTRACT_MONTHLY_BUDGET_USD` is above 0. To start with recordings
only, set `EXTRACT_THREAD_DAYS=0` and `EXTRACT_UNFILED=0`. To try threads by hand:

```bash
EXTRACT_MAX_PER_RUN=1 EXTRACT_THREADS_PER_RUN=5 npm run worker:dev -- --steps extract
```

## Phase 1: facts written directly (2026-10-29)

Before Phase 1 every fact waited on Review, so `list_open_commitments` stayed empty until Ben
approved items one by one (and the step had never run: `EXTRACT_MONTHLY_BUDGET_USD` was unset).
Now, with `EXTRACT_FACTS_MODE=direct` (the default):

- A commitment, task, follow-up, decision or price at `EXTRACT_FACT_MIN_CONFIDENCE` (0.75) or more is
  written to `facts` as open straight away (`origin = 'extract'`), with the verbatim `quote`, the
  `message_index` (texts, email, note paragraphs) and `due_text`, the deadline as said. `due_date` is
  resolved from it against the moment it was said, in Ben's time zone (`server/facts/dates.ts`:
  "Friday" said on a Tuesday is that week's Friday). Between `EXTRACT_MIN_CONFIDENCE` (0.6) and 0.75 a fact
  still goes to Review, and so do speaker matches and project links.
- The kind list gains `task`. Vague talk ("we should talk sometime") is excluded by the prompt.
- **One promise, one fact.** The model sees the open items on record for the people in the
  conversation and returns `same_as_fact_id` for a repeat; failing that, the same normalized text, or
  close wording for the same owner, within `EXTRACT_DEDUPE_DAYS` (90), is the same fact. A repeat adds a
  row to `fact_sources` instead of a new fact; `list_open_commitments` lists the other moments as `also_said_in`.
- Ben is a party (created once, `external_refs.vault_owner`, with his emails) so "Ben owes this" is
  recorded as `owner_party_id`.
- Every kind is read: meetings, calls, voice memos, uploads, **Apple Notes** (paragraphs, no
  transcripts row), texts and email. `EXTRACT_WORKSPACES` now defaults to `*,inbox`, because most
  texts, email, iPhone calls and every note sit in `inbox`. personal and phalanx still need listing.
- `interactions.facts_status` records where extraction stands (`done`, `waiting` on budget, `failed`);
  `pipeline_status` keeps meaning "transcript ready", so a budget that runs out hides nothing.
- Close a fact by hand with **Done** on the recording page (`PATCH /api/facts/:id`, `done` / `dropped` / `open`).
- `EXTRACT_FACTS_MODE=review` restores the step-2 behaviour.

**Backfill:** `npm run extract:backfill -- --dry-run` (counts and cost), then `--phase recent` (last 30
days), then `--phase rest`. Rate-limited (`--rpm`, default 20), resumable, never overlaps the hourly run.

## Code map

```
server/worker/extract.ts      prompt, schema, context block, guardrails (toProposals, dedupeProposals), the step
server/facts/store.ts         writing facts: dedupe into fact_sources, Ben's party, closing a fact
server/facts/dates.ts         spoken deadlines ("Friday", "end of next week") to dates
scripts/extract-backfill.ts   npm run extract:backfill
server/services/review.ts     APPLIERS: what approving each proposal type writes
server/worker/report.ts       extraction counts and spend for the Pipeline page
server/workspaces/classify.ts the workspace classifier unfiled recordings are read under
db/migrations/0007_extract.sql, 0011_extract_threads.sql
tests/api/extract.test.ts     the step against a mock Claude (recordings, threads, unfiled), and every applier
tests/unit/extract.test.ts    guardrails, dedupe, the thread context block and chunker
```

## Not in this step

Creating new people from a transcript (only known parties are referenced; agents can still propose
`new_party`). Marking facts done or overdue, and drafted replies, are step 5 C; Gmail drafts are step 5 D
([FOLLOW-THROUGH.md](FOLLOW-THROUGH.md)). Calendar and AnotherStoryBLDR writes come later.
