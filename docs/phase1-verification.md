# Phase 1 verification: commitment extraction, Zoom filing and linking, Apple Notes check

Branch `claude/new-session-vk1vay`, 2026-10-29. Built on `main` after PR #24 (thread extraction and
follow-through), which landed while this work was starting. The code map I worked from is
[phase1-map.md](phase1-map.md).

**Read this first: what is proven and what is not yet.** Nothing has been written to production.
From this cloud session the database is reachable only through the Neon SQL tool (no direct
Postgres, no Anthropic key for the app), so:

- **Proven on real data:** the filing and linking backfill. I copied what the resolver reads from
  production (read-only role, checksums matched) into a local database and ran the real
  `npm run resolve:backfill` against it. The numbers and the `list_interactions` output below come
  from that copy. Migration `0013` was applied to a Neon branch of production
  (`phase1-verify-2026-10-29`) and applies cleanly; `mcp_reader` can read `fact_sources` there.
- **Proven with a scripted Claude in tests, not yet on real data:** extraction writing facts.
  `list_open_commitments` after the backfill, and the 5 spot-checked facts, need the backfill to run
  in the worker Repl (it has the Anthropic key and the budget). Those two sections say so below
  rather than show anything invented. The commands are in "Turning it on".

## Root cause: why `list_open_commitments` is empty

Extraction has never sent a request: `EXTRACT_MONTHLY_BUDGET_USD` is unset on the worker, so the step
logs "extraction is off" and returns. Production has 0 interactions with `extracted_at`, no
`anthropic-extract` spend, and not one `new_fact` item in `review_queue`, ever. Even with a budget it
would still have shown nothing: the step only queued proposals on Review, and the one code path that
inserts a fact is approving one. It also skipped every unfiled Zoom recording, every Apple Note (notes
have no `transcripts` row), and everything in `inbox` (most texts, email and calls).

## `list_open_commitments` (limit 20) after the backfill

Not run yet; it needs the worker. Production today, raw:

```json
{"count":0,"items":[]}
```

What the tool returns once facts exist, from `tests/api/phase1.test.ts` (one item, scripted Claude):
`kind`, `text`, `owner`, `due_date` resolved from `due_text` ("Friday" said Tuesday 2026-10-27 →
`2026-10-30`), the verbatim `quote`, `source.message_index` for a thread, and `also_said_in` with the
two later calls that repeated the same promise. No new required inputs, so connected clients need no
change.

## 5 spot-checked facts

Not possible until the extraction backfill has run on real conversations. After
`npm run extract:backfill -- --phase recent`, the check is: open `/review`, or call
`list_open_commitments`, pick five, follow each `deep_link` to the moment, and compare the `quote`
with the transcript.

## `list_interactions kind=meeting limit=10` after the Zoom backfill

The real tool (`server/mcp/tools/interactions.ts`), token scope `*`, run on the production copy after
`resolve:backfill --apply`. Key fields per item. `has_transcript` and `duration_sec` are omitted
because the copy carries no transcripts.

```json
{"interaction_id": "8603", "title": "<lead>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1243}]}
{"interaction_id": "8566", "title": "<name> : AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1539}]}
{"interaction_id": "8507", "title": "Another Story's Zoom Meeting", "workspace_id": "another_story", "participants": []}
{"interaction_id": "8500", "title": "<contractor>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 7}]}
{"interaction_id": "8501", "title": "<name>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1541}]}
{"interaction_id": "6151", "title": "<LEAD IN CAPS>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1255}]}
{"interaction_id": "5941", "title": "<name>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1543}]}
{"interaction_id": "5937", "title": "<first name> <initial>: AnotherStory Assessment", "workspace_id": "another_story", "participants": []}
{"interaction_id": "5936", "title": "<lead>: AnotherStory Assessment", "workspace_id": "another_story", "participants": [{"party_id": 1226}]}
{"interaction_id": "5934", "title": "Another Story's Zoom Meeting", "workspace_id": "another_story", "participants": []}
```

(Names are left out of the committed copy because they come from production data. The full output,
names included, is in the session's scratchpad (`phase1-verification-full.md`); re-run the tool to see it.)

Parties 1243 (Ryan Meagher), 1255 and 1226 are existing leads: `list_leads` on the copy now shows each
assessment as that lead's `last_conversation`. 1255 matched despite a middle initial on the lead record
and an all-caps title. 1539 (Allan Lajeunesse, stray space before the colon) and 1543 are new parties.
1541 ("Bejamin Schiavi") is also new, typo included: no Benjamin Schiavi exists in the vault, so there
was nothing to suggest. Rename him on the People page. #5937 (a first name and an initial) stays
unlinked, since that is not enough to create a person. The two "Another Story's Zoom Meeting" rows are
filed by title with nobody named. On production the Calendar lookup (the `ben@anotherstory.com`
Meet account already has `calendar.events.readonly`) should fill in many of these; the copy could
not call Google.

## Counts before / after

| | production now | after the resolve backfill (production copy) | after the extraction backfill |
|---|---|---|---|
| interactions with null workspace | 879 (872 Zoom, 7 uploads) | 672 (665 Zoom, 7 uploads) | unchanged |
| interactions with no participants | 3,534 | 3,440 | unchanged |
| of those, Zoom meetings | 1,081 | 1,011 | |
| of those, iPhone calls | 57 | 33 | |
| open facts | 0 | 0 | not run yet |

The resolve backfill checked 1,195 recordings and calls and filed 208 under `another_story` (169 by title
rule, 39 by the people on them). It made 94 participant links, 13 of them to leads, created 53 people,
queued 2 suggested matches for Review (a middle name added to a lead's name, and a middle name left
out), and had 0 errors. The full per-recording report is in this session's scratchpad (it
lists people's names, so it is not committed); `npm run resolve:backfill -- --report out.md`
regenerates it on the worker.

"No participants" stays high because most of the remaining 1,011 Zoom meetings are titled
"Ben Strout's Zoom Meeting" (126 of the unfiled ones), and their transcripts (Groq) carry no speaker
names. Calendar guests and Zoom's participant list are the only sources for those: calendar works on
production, and Zoom's list needs one more scope (judgment calls below).

**The dry run paid for itself.** The first pass over real titles would have created people named
"Next Steps", "<first name> Ben", "Ben Strout's" and "<surname> Feasibility Study". The parser now creates a
person only from a deliberate shape (`<Name>: …`, `<Name>, …`, `Call/Meeting with <Name>`), a phone
contact, a calendar guest or Zoom. Names picked out of free text only match people already known.
Those titles are in the unit tests.

## Call sync status (item 3)

- **The ingester is healthy.** The iPhone call recordings do come from the Apple Notes ingest: the Mac
  collector `collectors/apple-media` reads call recordings out of Notes' attachments (`source =
  iphone_call`), alongside plain notes (`source = apple_note`, kind `note`). `import_runs` shows a run
  every 10 minutes, the last at 2026-10-29 01:45 UTC, all `ok`. The latest run scanned 1,600 notes,
  136 voice memos and 74 call recordings, and had nothing new to send.
- **Calls are current, not stalled.** 73 `iphone_call` interactions are stored, the newest
  2026-10-28 19:14 UTC. Oct 21 is only the newest call that was *filed*: 57 calls
  sit in `inbox`.
- **Plain notes are ingested.** 1,600 interactions of kind `note`, the newest 2026-10-28. On the Mac,
  644 notes were skipped as too short and 99 as empty, by design.
- **Why the MCP tools show neither:** every note, 57 calls, 457 of 529 text threads and 196 of 225
  email threads are in workspace `inbox`, and a `*` token never includes `inbox`
  (`server/mcp/scope.ts`). To see them, add `inbox` to the Claude connector token's scope on the
  Agents page. I did not change token scopes myself.
- **What Phase 1 changes here:** the resolver now links iPhone calls by the contact name the phone
  sent and files a call when its person maps to one workspace (24 of the 57 gained a person on the
  copy; one moved out of `inbox`). The new people have no role yet, so their calls stay in `inbox`
  until they get one; the refile step moves them then. Extraction now reads `inbox` and notes.

No backfill from Oct 21 is needed: nothing was missed.

## Judgment calls

- **Facts are written directly**, not queued, at confidence ≥ 0.75 (`EXTRACT_FACTS_MODE=direct`,
  `EXTRACT_FACT_MIN_CONFIDENCE`). 0.6–0.75 still goes to Review, so does every speaker and project
  link. `EXTRACT_FACTS_MODE=review` puts it back the way it was.
- **A separate `facts_status`** instead of holding `pipeline_status` at "not ready": a budget that runs
  out must not hide thousands of transcripts from search and the library.
- **Fact types:** `task` is added. "follow_up" and "amount" map to the existing `followup` and `price`
  (the MCP tool already accepted `follow_up`), so stored data and clients are unchanged.
- **Ben is a party** ("Ben Strout", `external_refs.vault_owner`, his emails), created once by the
  extractor, so `owner_party_id` can say Ben owes it. He is still never linked as a participant.
- **Message index:** for texts and email it is the segment index of the message; for a note, the
  paragraph number. A note's `quote_start_sec` is 0.
- **Spoken dates** (`server/facts/dates.ts`, America/Chicago): "Friday" is the next Friday on or after
  the day it was said; "next Friday" is the following week's; "next week" is next week's Friday (a
  due-by date); "end of week" said on a weekend is the coming Friday; a date without a year rolls to
  next year only if it would be over 60 days past; "soon" / "next month" / "ASAP" stay null.
- **Dedupe across conversations** looks at open facts in the same workspace *or* owed by / about the
  same person anywhere (the email is often in `inbox`, the call filed). A fact first heard in `inbox`
  moves to the filed conversation's workspace when a filed one repeats it.
- **`EXTRACT_WORKSPACES` defaults to `*,inbox`.** If the worker sets it explicitly, add `inbox` there.
  `personal` and `phalanx` still need listing.
- **Close button:** `done`, plus `dropped` (not happening, or never a real commitment) on the endpoint;
  the page shows Done / Undo.
- **Filing rules** live in `config/filing_rules.yml`. Per your rules, "Another Story's Zoom Meeting"
  (the account's default title) files under `another_story`: it contains "Another Story". Delete that
  pattern if it is wrong. "Ben Strout's Zoom Meeting" stays unassigned.
- **Feasibility studies** moved from `strout_arch` to `another_story` in the classifier's rules too
  (`server/workspaces/rules.ts`), so the two never disagree. Patterns: feasibility, discovery call,
  onboarding, delivery/deliveries.
- **Guardrails on filing:** never moves a filed recording; never assigns phalanx; never repeats a filing
  you rejected on Review (72 such rejections exist and are respected). `inbox` counts as unfiled.
- **People:** email first (party emails, then lead emails), then exact normalized name (party and lead
  names; middle initials, case and possessives ignored). Two people with the same name: the one with a
  lead record wins if exactly one has it, otherwise nobody is linked. A near miss ("Bejamin" vs
  "Benjamin", "Jon" vs "Jonathan" with the same surname, an email-named placeholder whose address spells
  the name) becomes a suggestion on Review, never a link or a merge. A new person needs an email or a
  full name from a deliberate source (above). Companies ("<name> Steel") are never people.
- **A placeholder party named after its email** gets the real name when the email matches a named
  calendar or Zoom participant. Nothing else about an existing party is overwritten.
- **New people get no role.** Roles say how someone relates to a venture; a title alone does not say
  that. The Leads sync still gives leads their prospect role.
- **Zoom's participant list needs `meeting:read:admin`** (or the granular past-meeting scope), which the
  recording app does not have today. The first refusal is stored in `worker_state`
  (`zoom_participants`) and the call is skipped for a day, so it costs one request a day until you add
  the scope.
- **Calendar matching:** events overlapping the call ±15 minutes on every connected Google account
  with `calendar.events.readonly`, scored on a Zoom link, the title's names and the start time; with
  several candidates it has to look like the call, otherwise nobody is taken from it.
- **Resolve waits for the transcript** (or a failed transcription), so speaker names are there.
  Title filing also runs the moment a Zoom recording is first seen.
- **Backfills follow the dev → report → approval → prod pattern:** `resolve:backfill` is a dry run by
  default (everything inside a rolled-back transaction, with exact "after" counts). It is undoable as a
  set: `resolved_by`, `filed_by` and `external_refs.created_by = 'participant-resolver'` mark
  everything it wrote.
- **The worker's step list** now comes partly from the adapter registry; order unchanged except the new
  `resolve` step between `transcribe` and `embed`.
- **Migration numbering:** this is `0013`. The unmerged `claude/social-dm-ingest` branch also calls
  itself v0.11 and will need renumbering when it lands.

## Phase 2 hooks: where new sources plug in

`server/ingest/adapters.ts` is the list of every source. A new source is one adapter file
(`server/ingest/<source>.ts`) and one entry in `INGEST_ADAPTERS`, plus a filing rule if titles say where
it goes. Pull adapters (`run` + `step`) join the worker's steps automatically; push adapters describe
their `/api/ingest` route. A new `interactions.kind` / `source` value needs the check constraints
widened in a migration and the MCP kind enum. Extraction, embedding, search, MCP and follow-through
need nothing.

- **Google Meet via Drive already exists** (the `meet` adapter, `server/meet/`, `drive.meet.readonly`).
  The `ben@anotherstory.com` account is connected and has calendar access. Phase 2 for Meet is mostly
  turning on `MEET_SHARED_DRIVES` or connecting more accounts.
- **TikTok and Instagram DMs:** a push adapter posting to `POST /api/ingest/messages` (the iMessage
  path: one `dm_thread` per conversation per day, `source = tiktok | instagram`), placeholders in the
  registry. The unmerged `claude/social-dm-ingest` branch already has a start on it.

## Tests

`npm test`: 37 files, **354 tests, all passing** (307 before, plus the PR #24 tests and these):

- `tests/unit/dates.test.ts`: date resolution (weekdays, "next Friday", end of week/month, business
  days, month names, numeric dates, time zone edge, vague phrases).
- `tests/unit/filing.test.ts`: the title parser (stray-space colon, all caps, Ben left out, the junk
  titles from the production dry run), name normalisation and fuzzy matching, and the workspace rules
  file (shipped rules, sources, order, bad config).
- `tests/api/phase1.test.ts`: the resolve step (dry run keeps nothing; title filing; known, lead, new and
  typo'd people; phalanx and a rejected filing respected; iPhone call moved out of inbox; Zoom 403 backs
  off for a day; Zoom and calendar participants by email, Ben excluded) and extraction (fact written
  with quote, message index and resolved date; an email and two calls folded into one fact, by the
  model's `same_as_fact_id` and by wording; a note's task owned by Ben; vague talk not written;
  `list_open_commitments` with `also_said_in` and inbox scoping; closing and reopening a fact, CSRF
  and 404 / 400).

Two existing tests changed on purpose: the step-2 extraction tests pin `EXTRACT_FACTS_MODE=review` and
`EXTRACT_WORKSPACES=*` (what they test), and the classifier test now files a feasibility discovery
call under `another_story`.

## Turning it on (production, in order)

1. Apply `db/migrations/0013_facts_and_filing.sql` to `main` (as with 0012); `/api/health` → `v0.13`.
2. Pull and redeploy both Repls.
3. Worker shell: `npm run resolve:backfill -- --report resolve.md` (dry run), read the report, then
   `npm run resolve:backfill -- --apply`. The hourly `resolve` step keeps new recordings linked from then on.
4. Set `EXTRACT_MONTHLY_BUDGET_USD` on the worker (the dry run below prints the estimate first).
5. `npm run extract:backfill -- --dry-run`, then `--phase recent`, then `--phase rest`.
6. Spot-check five facts, and paste `list_open_commitments` into the empty sections above.
7. Optional: add `meeting:read:admin` to the Zoom app; add `inbox` to the Claude connector token's scope.
8. Delete the Neon branch `phase1-verify-2026-10-29` (`br-shy-dawn-b81i2nt6`) once you no longer need it.
