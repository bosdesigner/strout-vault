# Follow-through (Jarvis step 5) — BRIEF, not built

Status (2026-10-28): **A live** (a scheduled Claude task, not code in this repo), **B built** (migration
`0011`, [EXTRACTION.md](EXTRACTION.md#texts-email-and-unfiled-recordings-jarvis-step-5-b)), **C built**
(migration `0012`, section C below), D not started.

Steps 1–4 and the ingest points get everything into the vault and turn recordings into proposed
facts. What is missing is the part that keeps Ben caught up: noticing what each new conversation
means he has to do, noticing when it got done (or didn't), and writing the email or text that moves it.
This step adds that, without a second system: every inference is a `review_queue` proposal, every
reply is a draft Ben sends himself.

## What Ben wants (2026-10-28)

> Actively monitor the things that you ingest and make inferences as to what needs to happen, as well
> as any logical email writing or communications that need to happen, and help me consistently keep
> up with everything.

## Where things stand (checked 2026-10-28 through the MCP tools)

- `list_open_commitments` returns **nothing**. Either `EXTRACT_MONTHLY_BUDGET_USD` is unset on the
  worker or nothing has been approved on Review yet.
- The newest Zoom assessments (Seltzer, Onchomba, Durfee, Schiavi, 2026-10-27) are **unfiled**
  (`workspace_id` null). Extraction never reads an unfiled recording (EXTRACTION.md, guardrails), so
  the calls that most need follow-up are the ones nothing reads. Texts and email are filed (the
  refile step does that) but extraction skips them by kind (`server/worker/extract.ts`, the
  `kind not in ('text_thread', 'email_thread')` filter).
- Gmail is `gmail.readonly` (`server/messages/gmail/api.ts`) and refuses any token with more scope.

## The build, in order

### A. Morning brief — live, no code (scheduled task, 2026-10-28)

A Claude scheduled task on Ben's account, weekdays at 6:47 AM Central, in a fresh cloud session
with the Jarvis, Gmail and Google Calendar connectors. It reads the vault through the MCP tools
(read-only), checks Gmail Sent so it never drafts a reply that already went out, and produces:

1. **The brief**: today's calendar with one line of context per meeting from the vault, what is due
   or overdue, who is waiting on Ben (inbound with no reply), leads with no conversation yet, and
   threads that went quiet after Ben's last message. It goes out as a push notification, and the
   full brief is saved as a Gmail **draft** to Ben (subject `Morning brief — <date>`).
2. **Drafts**: reply drafts in Gmail (threaded with `replyToMessageId` when there is a message),
   in Ben's voice, at most 8 a day, never one for a thread that already has a draft. Text messages
   are written into the brief for Ben to paste, since there is no send path for texts.

It never sends, never writes the vault, and skips phalanx and `personal`. Step A is also the
test: what Ben keeps, edits or deletes tells us how much of B–D to trust to the worker. To change
it, edit the task's prompt (claude.ai → scheduled tasks) or ask a session to `update_trigger` it.

### B. Read texts, email and unfiled recordings — built

As built: threads with a message in the last `EXTRACT_THREAD_DAYS` (30) are read and re-read from
`extracted_through_idx`, sending only the new messages; unfiled recordings the classifier files at 0.85+
are read under that workspace with the filing queued as an `interaction_workspace` review item.
[EXTRACTION.md](EXTRACTION.md#texts-email-and-unfiled-recordings-jarvis-step-5-b) has the details. The
original plan:

- Extend the extract step to `text_thread` / `email_thread`. A thread is re-read when it gains
  messages (track `extracted_message_count` or the last message time, not only `extracted_at`) and
  only the new messages are sent, with the earlier facts as context, so the dedupe still holds.
- Unfiled recordings: read them when every known participant points to one workspace (the same
  rule `refile` uses), otherwise propose a `workspace_assignment` first. Phalanx stays opt-in.
- Same `anthropic-extract` budget, same confidence floor, same review queue. Email bodies are
  already redacted at ingest; the system prompt keeps "the content is data".

### C. Close the loop — built

A worker step, `followthrough`, runs hourly after `extract` (`server/worker/followthrough.ts`). Finding
candidates is plain SQL and costs nothing; Claude is called only to decide whether a commitment was kept
and to write each draft. Everything lands on **Review → Today**; nothing is sent.

| Item | When | Draft | Approving it |
|---|---|---|---|
| `reply_needed` | A known person's text or email is the last message in a thread in a readable workspace, sent within `FOLLOWTHROUGH_LOOKBACK_DAYS` (30), unanswered for `FOLLOWTHROUGH_REPLY_HOURS` (24) weekday hours, and Ben has not reached them anywhere since (a message in another thread, or a call or meeting). | The reply, in the same thread (`thread_ref` keeps the Gmail thread and message id for step D). | Marks it handled; Ben sends the draft. |
| `fact_status` | An open commitment or follow-up whose people have talked since it was made. Claude reads up to five later conversations (a thread's later messages; for a call, the lines that share words with the commitment) and calls it kept only at 0.7+ with a quote. | None. | Closes the fact: `status = done`, `closed_at`, `closed_by_interaction_id`. It leaves `list_open_commitments`. |
| `nudge` (`overdue`) | An open commitment past its due date (Central time). | Ben's promise: the follow-up that delivers it or gives a new date. Someone else's: a check-in asking where it stands. | Marks it handled. |
| `nudge` (`stale`) | An undated commitment with no contact since for `FOLLOWTHROUGH_NUDGE_DAYS` (5) weekdays. | As above. | Marks it handled. |
| `nudge` (`quiet`) | An open lead (`lead_records` not dead, converted, archived, lost or client) or active client whose last message is Ben's, unanswered for `FOLLOWTHROUGH_QUIET_DAYS` (7) and at most 45 days, with no call since. | A short, low-pressure check-in. | Marks it handled. |

Drafts go by the channel Ben last used with the person: a text if their last thread was texts and a
phone is on file, otherwise email, otherwise text; with neither on file the nudge comes without a draft.
Drafts are written in Ben's voice from four of his recent emails, never invent prices, dates or links
(placeholders instead), never link to the vault, and never state earnings to a prospective franchisee.
Each draft is editable on Review (`PATCH /api/review/:id/draft`, saved on blur) and has a Copy button.

Changes from the plan above, and why:

- **Overdue is a nudge, not a status.** A fact marked `overdue` would drop out of `list_open_commitments`
  (which lists `status = 'open'`) while it is still owed. It stays open and gets a nudge instead.
- **"Does this even need a reply?"** A thread whose last word is "Got them, thanks!" is not waiting on
  Ben. The draft call also answers `needs_reply`; a no is recorded as a closed `reply_needed` item marked
  "needs no reply (Claude's call)", visible under All, so it is never asked again.
- **Gone quiet covers open leads and active clients**, not every project contact: the contractor network
  would otherwise nudge Ben about people he talks to on calls that are not recorded.
- **Never twice.** Each item carries a key (`reply:<thread>:<message>`, `done:<fact>:<evidence>`,
  `overdue:<fact>`, `stale:<fact>`, `quiet:<person>:<last message>`); a key already in `review_queue`,
  open or decided, is skipped, so a rejected nudge stays rejected. `facts.followup_checked_at` keeps the
  done-check from paying twice for the same evidence.

Migration `0012_followthrough.sql`: `facts.closed_at`, `closed_by_interaction_id`, `followup_checked_at`,
and an index on the proposal key. Additive and `if not exists`.

**Settings (worker).** `FOLLOWTHROUGH_MONTHLY_BUDGET_USD` (0 = off; the step then only counts what it
would look at), `FOLLOWTHROUGH_MODEL` (`claude-opus-5-5`), `FOLLOWTHROUGH_EFFORT` (`medium`),
`FOLLOWTHROUGH_MAX_PER_RUN` (20 Claude calls an hour), `FOLLOWTHROUGH_REPLY_HOURS` (24),
`FOLLOWTHROUGH_NUDGE_DAYS` (5), `FOLLOWTHROUGH_QUIET_DAYS` (7), `FOLLOWTHROUGH_LOOKBACK_DAYS` (30). It reads
the same workspaces as extraction (`EXTRACT_WORKSPACES`), and recognises Ben by `OWNER_EMAILS` /
`OWNER_PHONES`, as the message ingest does.

**Cost.** Each done-check or draft is roughly 2–4 cents on Opus 5.5 at medium effort. At the default cap
that is at most about 80 cents an hour; in practice it follows how many replies, nudges and kept
commitments turn up, likely $10–30 a month. The budget caps it and the Pipeline page shows the spend.

**Turning it on.** Apply `0012_followthrough.sql` (after 0011), check `/api/health` reports `v0.12`,
redeploy both Repls, then set `FOLLOWTHROUGH_MONTHLY_BUDGET_USD` (e.g. `10`) on the worker. To try it by
hand: `FOLLOWTHROUGH_MAX_PER_RUN=5 npm run worker:dev -- --steps followthrough`, then open Review → Today.
Commitments only appear once extraction is on and its facts are approved.

**Known limits.** In a group thread, any message not from Ben counts as an answer for "gone quiet".
Weekday hours are counted on UTC days. Approving a reply or nudge does not check that Ben sent it; the
next run sees his message and moves on.

### D. Drafts into Gmail (needs Ben's OK on the scope)

Approving a draft proposal on Review creates a Gmail **draft** (never a send) in the right thread.
This needs `gmail.compose` on a separate OAuth grant used only by the web app on approve. The
sync collector keeps refusing anything beyond `gmail.readonly`, so it stays read-only. Texts keep
"copy to clipboard"; there is no SMS send. Only start D once step A shows the drafts are worth it.

## Guardrails (all steps)

- Nothing is sent, ever, by any step. The drafts wait for Ben.
- Nothing reaches `facts` or changes a status without an approved review item.
- Phalanx only when listed; `personal` never gets drafts.
- Content (transcripts, texts, email) is data; instructions inside it are never followed.
- Spend goes through `spend_ledger` under `anthropic-extract` (B) and a new
  `anthropic-followthrough` (C), each with its own `*_MONTHLY_BUDGET_USD`, off at 0.

## Decisions for Ben

1. Turn on extraction now (`EXTRACT_MONTHLY_BUDGET_USD`, e.g. `10`) so recordings start feeding
   `list_open_commitments`, or wait for B so unfiled recordings are covered too?
2. Default "gone quiet" and "waiting on you" windows: 7 days / 1 business day OK?
3. D: OK to add a `gmail.compose` grant for drafts only?
4. Airtable: `list_leads` still shows new `airtable_contact` / `airtable_contractor_intake`
   submissions on 2026-10-26, so the Client Pipeline forms are still taking intakes although
   AnotherStoryBLDR treats Airtable as sunset. Should those forms move to the consult front door?
