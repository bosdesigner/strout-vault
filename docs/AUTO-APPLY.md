# Auto-apply: context-aware approval of proposals

Before this, every proposal Jarvis made (`propose_update`, the extractor) waited on the Review page.
Now each proposal still lands in `review_queue` first, then `server/services/autoApply.ts` decides,
in the same transaction as the apply:

## Auto-apply when all of these hold

| Check | What it means in code |
|---|---|
| **Source context** | The proposal cites an interaction, and one of these is true: its quote is really in that conversation (`source_quote`, the extractor's `“…” at m:ss` reason, or `evidence.quote`); its timestamp lands on a line; or the proposed values appear verbatim in the conversation's words. "Words" means transcript lines and message bodies. A sender's display name or number in the headers doesn't count, because that's how every unknown sender looks, newsletters included. |
| **Additive** | `new_party` without a `role`. `party_edit` that only adds phones/emails to a party with **none** of that kind. `link_party_interaction`. `link_project_interaction`. `new_fact` of kind `commitment`, `task`, `followup`, `price`. |
| **Verbatim values** | `new_party`: the name, every phone and email (and location/website if given) are in the source. `party_edit`: each added phone/email is in the source. `link_party_interaction`: the party's full name (or one of its phones/emails) is in the source, or there's a quote/timestamp plus confidence. `link_project_interaction`: the project name or address is in the source, or there's a quote/timestamp plus confidence. `new_fact`: the quote is in the source (or the fact text verbatim); for `price`, the amount appears as written ($12,500 / 12500 / 12.5k). |
| **Confidence** | ≥ `AUTO_APPLY_MIN_CONFIDENCE` (0.85). When no confidence is given and the values are verbatim, 0.9 is assumed. |
| **No conflict** | No other party has the same phone (last 10 digits), email, or exact name (same kind). The speaker label isn't already someone else's on that conversation. The party isn't a merged duplicate. |

Phones compare on their last ten digits. Names and quotes compare lowercased, with punctuation and
spacing ignored, as whole words.

## Queue for review when any of these apply

The `rule` field says which one (the first that held it back; `also` lists the rest):

- `no-source`: no interaction, or nothing ties the proposal to it
- `inference:role` (lead type, contractor vs homeowner, market), `inference:relationship`, `inference:fact-decision` / `-issue` / `-preference` / `-other`
- `edits-existing:name|phone|email|location|website|notes|speaker-label|merged-party`
- `possible-duplicate:phone|email|name`, `conflict:speaker-label-taken`
- `low-confidence:0.xx`, `confidence-unknown`
- `not-verbatim:name|phone|email|amount|location|website`, `not-quoted`, `quote-not-in-source`
- `not-additive:<type>`: workspace filings, speaker matches (`participant_match`), follow-through items (`reply_needed`, `nudge`, `fact_status`) always wait for Ben
- `auto-apply-off` (`AUTO_APPLY=off`), `auto-apply-unavailable` (migration 0014 not applied)

Queued items keep the verdict in `review_queue.route`; the Review page shows "Waiting for you: …".

## Safety

- **Audit log**: `auto_applies` holds one row per auto-apply: `applied` (what changed), `rule`,
  `source_quote`, `confidence`, `actor` (`mcp:<token>`, `extract`, `reevaluate`), and `undo`.
  The review item becomes `approved` with `decided_by = 'auto'`.
- **Undo**: Review → **Auto-applied** lists the last 7 days, each with an **Undo** button
  (`POST /api/review/auto-applied/:id/undo`). Undo replays the recorded steps last-first in one
  transaction, which deletes the rows it created, removes only the phones/emails it added, un-assigns
  only the transcript lines it assigned, and restores fields it filled. It then marks the log row
  undone and the review item `rejected` (`decided_by = 'undo'`). If something added later points
  at a created row (e.g. a fact about a new party), Undo refuses with a 409 and changes nothing.
  Fix that record first. Undo steps are whitelisted to the tables and columns the appliers write.
- **propose_update** returns `{applied: true, rule, review_id, auto_apply_id, changed}` or
  `{applied: false, rule, also?, queued: true, review_id}`. Claude tells Ben which happened.
- The MCP insert still runs as `mcp_proposer` (INSERT `review_queue` only). The rules and the apply
  run with the app's own connection, the same code path as the Review page's Approve.
- Kill switch: `AUTO_APPLY=off` (web app and worker). Before migration 0014 is applied, everything
  queues as before.

## Re-evaluating the current queue (one-off)

PRODUCTION-OPS: dry run, then Ben reviews it, then apply only after his explicit OK.

1. **Dry run** (read-only, works before 0014 is applied). In the Replit shell, where `DATABASE_URL` is the vault's Neon:

   ```bash
   npx tsx scripts/reevaluate-review.ts --out docs/auto-apply-verification/dry-run.json
   ```

   This prints `WOULD AUTO-APPLY` and `WOULD STAY QUEUED`, each item with its rule and source
   (interaction and quote). It also writes `dry-run.json` and a readable `dry-run.md`. **Stop here
   for Ben's OK.**
2. After approval: apply `db/migrations/0014_auto_apply.sql`, deploy, then

   ```bash
   npx tsx scripts/reevaluate-review.ts --apply --approved docs/auto-apply-verification/dry-run.json --out docs/auto-apply-verification/applied.json
   ```

   Only the dry run's "would auto-apply" ids are applied, and each is re-checked against the rules
   at apply time (anything that no longer passes stays queued and is listed). The script prints
   before/after open counts and every change, and each change gets an Undo on the Auto-applied tab.

## Tests

`tests/api/auto-apply.test.ts` covers these cases, all end to end over MCP:

- a verbatim new_party from a message is auto-applied
- an inferred lead type is queued
- a phone edit to an existing party is queued
- a duplicate phone is queued
- Undo reverses an auto-apply

It also covers the no-source, not-verbatim, quoted commitment and price, wrong amount, decision,
low confidence, fake quote, party/project tags, speaker-label conflict, the Undo refusal, the
`AUTO_APPLY=off` switch, and the dry run and apply of the queue re-evaluation.
`tests/api/extract.test.ts` checks the extractor's proposals go through the same rules.
