# Phase 1 (v2) verification: routing, extraction, linking

Production is Neon `relationship-engine` (`dry-snow-01633657`, branch `main`). The "before" numbers were
read at 2026-10-30 00:48 UTC, before any change. The "after" numbers and the MCP output were read after
the backfill described below. The map of how things worked before is [phase1-map.md](phase1-map.md).

## Summary

| | Before (2026-10-30 00:48) | After |
|---|---|---|
| Visible to Ben's connector | 1,297 (of 3,803) | **2,481** (of 3,805) |
| In `inbox` | 2,484 | **1,253** (684 of them with a suggested workspace on Review) |
| No workspace (unassigned) | 878 | **365** (193 with a suggestion on Review) |
| phalanx | 22 | **71** (+123 phalanx review items for borderline ones) |
| personal | 0 | **406** (now in the connector's scope) |
| Interactions with no participant | 3,572 | **3,530** |
| Open facts | 0 | **63** (63 `fact_sources`) |
| `extract` jobs pending | 225 | **0** (closed `skipped`) |
| Phalanx-term keyword search via the connector | 1 hit (#6387) | **0** |

Every one of the 3,803 interactions that existed was classified once (2 arrived during the run and wait
for the worker). Code: `claude/new-session-5kvgow` (3 commits). Production: migration 0013 applied, data
backfilled as described below. **The deployed app still runs the old code until both Repls pull and
redeploy.** See "To finish" at the end.

## Root causes

### Inbox pile-up (2,484 in `inbox`, 878 with no workspace)

1. **Routing only knew people who were already parties with a role, matched exactly by phone or email.**
   None of the 477 inbox text threads, 136 voice memos or 59 inbox calls had a single
   `interaction_participants` row, and the 211 inbox email threads had one between them. Unknown senders
   became `new_party` review items (277 open), so `routeThread()` answered "No participant maps to a
   workspace" and filed to `inbox`.
2. **Nothing read the content.** No routing path looked at the text.
3. **The Gmail mailbox was ignored.** All 211 inbox email threads came from the `ben@anotherstory.com`
   or `ben@stroutarch.com` mailboxes, whose workspace is never in doubt.
4. **Apple Notes routed only by folder**, the folder map shipped empty, and every note is in "Notes": all 1,601 went to `inbox`.
5. **Zoom was never routed at ingest** (`sync.ts recordRecording()` has no `workspace_id`). The only way out
   was a review item, and the title-regex classifier filed only ~6% of titles confidently. 126 meetings are
   titled "Ben Strout's Zoom Meeting".
6. **Review was the only exit, and it could not keep up.** On 2026-10-27, 623 `workspace_assignment`
   items with no suggestion were bulk-rejected.

### Stalled extract jobs (225 pending, never touched) and extraction only for media

- `jobs` dates from relationship-engine v0.1, when the meeting-vault Python service consumed it. The
  Strout Vault worker kept writing `transcribe` + `extract` job pairs (Zoom sync, Meet, uploads/device
  files, Twilio calls), but its extract step (`worker/extract.ts`) picks work by
  `interactions.extracted_at` and **never reads `jobs`**. Nothing consumed those 225 rows.
- A `jobs` row needs a `media_id`. Texts, email and notes have no media, so they never got one. That is
  why only media items had extract jobs.
- What extraction actually read was narrower still: filed recordings in `*` workspaces (never `inbox` or
  `personal`), inner-joined to `transcripts` (Apple Notes have no transcripts row), plus threads from the
  last 30 days. **0 of 2,480 inbox items had ever been read.**
- **Why there were 0 facts:** every extracted item went to `review_queue` as `new_fact`, and a `facts` row
  was written only when Ben approved one. 1,560 sat open. The worker was configured ($100/month) and
  running; it simply had nothing left that it was allowed to read.

**Fixed:** extraction reads every kind after classification and writes confident facts directly.
`extract` jobs are no longer written, and the 225 orphans are closed as `skipped` with that reason.

### Google Meet `capability: none_found`

**It is a Workspace/meeting setting, not a scope and not (mainly) a code bug.** The grant is right
(`drive.meet.readonly` + `calendar.events.readonly`). Checked directly with Ben's Google connectors on
2026-10-30:

- Calendar (ben@anotherstory.com): **4 Google Meet meetings organized by Ben in the last 30 days**, all
  cal.com "Claim your domain" contractor calls (Kevin McGuire 09-29, Joel Smith 10-22, Tanner Durfee 10-23,
  Brandon Karle 10-26).
- Drive: **no "Meet Recordings" folder, no Meet recording MP4 and no Meet transcript or "Notes by Gemini"
  Doc since January 2026.** The only MP4s are files other people shared.

So those meetings are not being recorded or transcribed, and there is nothing for the worker to find.
Turn it on in the Google Admin console (as a super admin): **Apps → Google Workspace → Google Meet → Meet
video settings → Recording: "Let people record their meetings" on, and Transcripts: "Let people use
transcripts" on** for the org unit ben@anotherstory.com is in. That needs a Workspace edition with Meet
recording (Business Standard or higher). Then either start Recording / Transcript in each meeting, or set
"Meeting records → Record / Transcribe the meeting automatically" in the Calendar event's Google Meet
video-call options. cal.com creates these events, so automatic recording has to be the account or event
default for booked calls.

There was also a code bug, now fixed: with no cursor, the listing only looked back 14 days, and the
cursor moved only when a recording was found. An account with no recent recording was therefore checked
over a rolling 14-day window and never backfilled. The first listing now reaches back 365 days, the cursor
advances even when nothing is found, and when nothing is found the account records why
(`detail.diagnosis`: Meet events in the last 30 days, Meet Docs seen, verdict
`meetings_but_no_recordings_saved` or `no_meet_meetings`).

## Before / after counts

Before (read 00:48 UTC, before any write):

```
total 3803 · another_story 365 · strout_arch 52 · credvault 2 · phalanx 22 · inbox 2484 · (null) 878
inbox: note 1601, text_thread 477, email_thread 211, recording 136, call 59 · null: meeting 871, other 7
no participants 3572 · facts 0 · open facts 0 · jobs: extract:pending 225, transcribe:done 221, transcribe:failed 4
connector scope: another_story, strout_arch, southern_shutter, sepp, credvault, unassigned
```

After (read after the backfill):

```
total 3805 · another_story 1500 · inbox 1253 · personal 406 · (null) 365 · strout_arch 192 · phalanx 71 · sepp 15 · credvault 3
inbox: note 882, text_thread 239, recording 54, meeting 56, call 20, email_thread 2 · null: meeting 364, other 1
no participants 3530 · facts 63 (open 63; another_story 58, strout_arch 2, sepp 2, inbox 1) · fact_sources 63
jobs: extract:skipped 225, transcribe:done 221, transcribe:failed 4 · classified 3803 of 3805
connector scope: another_story, strout_arch, southern_shutter, sepp, credvault, unassigned, personal
schema_log: v0.13 routing + facts + links
```

How it got there, in order:

1. **Migration 0013** applied in one transaction.
2. **Deterministic pass (SQL, same rules as `route.ts`):** 25 items with phalanx terms in the title or on
   2+ lines → phalanx; 210 inbox email threads → their mailbox's workspace; feasibility-study titles →
   another_story; every already-filed item without phalanx signals marked classified as it was.
   Single passing mentions and weak terms in unfiled items → inbox with a phalanx review item.
3. **Content pass (3,128 items):** Claude read the first 2,000 characters of each with the production
   prompt, and the app's `decideWorkspace()` turned each verdict into a decision (see the judgment calls
   for how). 854 review items were created for the uncertain ones, each with Claude's reason.
4. **Wound-care fix:** the leak test caught #6387. "wound care" now counts as a strong term
   (code + tests + production); #6387 moved to inbox with a phalanx review item.
5. **People:** 44 new participant links from exact title-name matches (160 matches, the rest already
   linked), 7 close-name suggestions on Review.
6. **Facts:** 63 facts from the extractor's proposals at 0.8+ (see below).

**Why inbox is still 1,253 and participants barely moved.** Most of what is left is genuinely
unclassifiable from its content: 882 Apple Notes that are logins, links, quotes or contact cards, and
one-line or spam texts. Claude scored them under 0.6. 684 of them carry a suggestion on Review. Most
people in texts and Zoom titles are not parties at all (277 `new_party` items are still open), so
there is nobody to link them to. The link step can only connect people the vault knows. Approving
`new_party` items, and adding `meeting:read:admin` to the Zoom app, are what move that number.

## Through the MCP server with Ben's connector token

Raw output in [phase1-verification/mcp-output.md](phase1-verification/mcp-output.md). These calls went
through the claude.ai "Jarvis" connector (Ben's OAuth grant, the deployed `/mcp`), not the database.

- `list_open_commitments limit=20`: **20 items** (it returned `count: 0` before). Examples: "Ben will have
  Jarvis put together the AnotherStory local domain holder package and send it to Ryan Meagher" (from
  yesterday's assessment), "Jesse Skelton will pay Another Story's feasibility visit invoice by the end of
  the week" (due 2026-10-09, from a text).
- `list_interactions kind=meeting limit=10`: the ten newest meetings, eight of them in `another_story` and
  two unassigned, all visible. Ryan Meagher, Lucas Seltzer, Jonathan Brou and Tanner Durfee are now
  linked as participants. Lucas Seltzer is party #1255, the lead from Airtable, so this is now his latest
  conversation on /leads.
- `list_interactions kind=call limit=10`: the ten newest iPhone calls, all visible (they were all in
  `inbox` before). Three are still titled "Call Recording" because no number is known yet (see People).

## Phalanx leak test

Through the connector, keyword mode: `Phalanx` → 0, `"Shingle X" OR ShingleX` → 0, `Dermatryx` → 0,
and the combined `"wound care" OR Phalanx OR "Shingle X" OR ShingleX OR Dermatryx OR "Dermal X" OR DermalX OR Millpond OR "cap table"` → **0**.
The first run of the test found one real leak, #6387 (texts with Greg Larkin, "We still don't have the
money for the wound care…", filed in another_story). I had treated "wound care" as a weak term that
needs Claude's confirmation before moving a filed item; it is now a strong term and #6387 is in inbox
with a phalanx review item. A semantic search for the same terms returns only conversations without
any phalanx term (investors in a property deal, partner equity); semantic search always returns its
nearest 15. Details in the raw-output file.

## Facts: five spot checks

Checked against the transcript or message around each fact's `quote_start_sec`:

| Fact | Source | Quote / context | Verdict |
|---|---|---|---|
| #19 Jesse Skelton will pay the feasibility visit invoice by the end of the week, due 2026-10-09 | text, Mon 2026-10-05 | "Got the invoice, too.. Will have it paid by EOW." | **Correct**: owner, promise and date (EOW from Monday Oct 5 = Fri Oct 9) |
| #53 Tanner Durfee will remove the second-story content from designyourprice.com and tell Ben when done | text, 2026-10-20 | "I'll let you know when that is adjusted so you can check it." | **Correct** |
| #58 Ben will send Jonathan Brou a summary, feasibility details and a payment link later today, due 2026-10-26 | Zoom assessment, 2026-10-26 | "I will send that over to you later today." / "I heard you'll send me a summary." | **Correct** |
| #62 Ben will have Jarvis put together the local domain holder package for Ryan Meagher | Zoom assessment, 2026-10-28 | "So, I will have Jarvis put together the…" (next steps) | **Correct**; no due date stated, none set |
| #54 Ben needs to send Valent Group the signed renewal application… so the Strout Architecture professional liability policy (expires 2026-11-20) renews | email, 2026-10-21 | "The current Professional Liability policy will expire on 11/20/26." | **Fact and date correct, workspace wrong**: it is Strout Architecture business, filed another_story because it came to the ben@anotherstory.com mailbox. That is the mailbox rule's known limit; the item can be moved from its page. |

**Why there are only 63.** The deployed (old) extractor scores most items 0.6–0.7: in the last 90 days of
readable proposals, 0.6–0.7 outnumbers 0.7–0.8 about 3:1, and very few reach 0.8. Promotion uses the same
0.8 floor as the new code, so the rest stay on Review (1,988 open `new_fact` items, mostly from before).
The new extractor's prompt asks for real commitments with honest confidence and writes 0.8+ straight
through. Once it is deployed and has run, this number reflects the new prompt, not the old one. Facts
across two sources: 0 yet (none of the promoted proposals repeated each other); the code path is
covered by `tests/api/phase1.test.ts`.

## Failed transcriptions

The four voice memos (6189 "Christ Fellowship Church", 6193 "Shoal Creek Rd", 6195 "Broadway St",
6197 "Another Story 3") had failed three times each with `ffprobe: moov atom not found`. That means the
m4a in storage is truncated: the collector copied each memo while it was still recording or still
downloading from iCloud. They are re-queued: `pipeline_status = queued`, transcribe job reset to
`pending` with 0 attempts. The hourly worker retries them. If the stored file is still truncated, the
same error is recorded again on `interactions.pipeline_error`. The fix then is to delete those four
`media` rows and let the Mac collector resend once the memo is complete on the Mac. #2468 (a 2023
meeting-vault import) has no media at all; that is now recorded as its `pipeline_error`.

**Retry result (worker run #153, 2026-10-30 03:01 UTC):** all four failed again with the same
`moov atom not found`. The stored files are 569, 1,478, 7,590 and 9,489 bytes, far too small for a
Voice Memo of any length: they are iCloud placeholders or partial copies. The error is recorded on each
row (`pipeline_status = failed`, `pipeline_error`). **To recover them:** open each memo in Voice Memos on
the Mac so it downloads, then delete those four `media` rows (ids by `interaction_id` 6189, 6193, 6195,
6197) and the collector resends them on its next pass. The collector could also skip files under ~20 KB
whose duration is over a second; not changed here.

## Near-real-time (iMessage, Gmail, calls)

- **iMessage and iPhone calls are already near-real-time on the ingest side.** The Mac collectors push
  every 15 min (iMessage) and 10 min (Apple media). What waited for the hourly worker was linking,
  classification and extraction.
- **Gmail** is pulled only by the hourly worker today. The 10-minute messages deployment in
  [MESSAGES.md](MESSAGES.md) step 5 (`WORKER_STEPS=gmail,embed`) was never published: every
  `worker_runs` row is on the hour.
- **Recommendation:** publish a third Scheduled Deployment (a Repl from the same repo) every 5 minutes
  with `WORKER_MODE=1` and `WORKER_STEPS=gmail,link,classify,embed`. These are the light steps: each takes
  its own advisory lock, so they never overlap with each other or with the hourly run, which keeps
  transcription, extraction and follow-through.
- **Cost flag:** 288 runs a day. Replit bills Scheduled Deployments per compute-second, and each light run
  is mostly an idle check of a few seconds: on the order of $5–15/month at current rates (verify on the
  Replit pricing page). Gmail and Neon calls are free at this volume. Claude spend does not rise: each
  item is still classified once, only sooner. Webhook push (Gmail Pub/Sub) would remove the polling but
  needs a GCP Pub/Sub topic and a public endpoint, so it is not built.

## Phase 2 hooks (TikTok and Instagram DMs)

A new conversation source is one adapter file plus one config line:
`server/messages/adapters/<source>.ts` exports a `ThreadAdapter` (zod schema + `toThreads()`), registered
in `ADAPTERS` in `server/messages/adapters/index.ts` and listed under `enabled:` in `config/sources.yml`.
The collector then POSTs to `/api/ingest/threads/<source>` with an `ingest:messages` token, and threads go
through the same path as texts: blocklist and redaction, party matching, `inbox`, then `link`, `classify`
(phalanx guard included) and `extract`. The `dm_thread` kind is in migration 0013 and in `THREAD_KINDS`.
The TikTok DM scrape plugs in as `tiktok_dm`; Instagram as `instagram_dm`. Neither adapter is written.

## Tests

`npx vitest run` on a local Postgres 16 + pgvector: **36 files, 396 tests, all passing**. The baseline
before this work was 34 files / 329 tests. `npx tsc` (server and client) is clean.

New:
- `tests/unit/phase1.test.ts` (61 tests). **Classifier:** the phalanx guard (title terms, 2+ lines, a
  single passing mention → inbox + review, wound care and cap-table / investor terms, Claude's
  `phalanx_material` flag, phalanx-only contacts, filed items moved out, words that merely contain the
  terms), the mailbox rule (stroubo has no default), feasibility → another_story, participants vs
  Claude, the 0.6 / 0.8 thresholds, undecided items staying put, when Claude is asked. **Title parser:**
  11 real titles including `Allan Lajeunesse : …` and `LUCAS SELTZER: …`, normalisation, never Ben.
  **Due dates:** 20 phrases from a Wednesday, the local-day rule, vague and past phrases.
  **People matching**, the calendar event picker, the call-log matcher, the stored kinds, the message
  index. **Scope:** phalanx and inbox never in `*`, personal ticked by default for the connector.
- `tests/api/phase1.test.ts` (7 tests, local DB + MCP server). The classify step without and with a
  budget (mock Claude), spend in `spend_ledger`, borderline phalanx → inbox + review. Extraction writing
  one open fact for a promise made on a call and again in a text (two `fact_sources`, Friday resolved to
  2026-10-30). Closing and reopening a fact through the endpoint (owner + CSRF). The link step (exact
  title name linked with its transcript lines, "Bejamin Schiavi" only suggested, "Call Recording"
  retitled from its number, Ben never linked). **Scope enforcement through the MCP server with a
  connector-shaped token:** personal facts visible, phalanx facts and searches return nothing, and inbox
  and phalanx requests are refused with the scope note.
- Existing tests were updated for the intended changes: one transcribe job (no extract job), feasibility
  → another_story, the unfiled-recording read replaced by "unfiled and inbox wait for the classifier",
  personal threads now read.

## Every judgment call

**Routing**
- **phalanx is now assigned automatically.** The old rule (`noAutoPhalanx`: phalanx always waits in
  inbox) contradicted the brief. phalanx is out of every connector scope, so filing there is the safe direction.
- **phalanx needs 0.8; everything else files at 0.6** (`CLASSIFY_MIN_CONFIDENCE`). A wrong guess between
  the readable workspaces stays inside Ben's own scope. A wrong guess out of phalanx would leak.
- **Strong phalanx terms** (Phalanx, Shingle X, Dermatryx, Dermal X, Millpond, wound care) in the title, or on 2+ lines,
  file to phalanx without Claude. A **single passing mention** moves the item out of any readable workspace
  into inbox with a phalanx review item, unless Claude reads it as phalanx at 0.8+. Example: #3342, a
  feasibility onboarding where a contractor mentions his side company "Shingle X".
- **Weak terms** (cap table, term sheet, pre/post-money, convertible note, SAFE, investor
  deck/update/meeting, pitch deck, seed/series round, Phalanx Nano) count as phalanx only together with
  Claude: an unfiled item with them waits in inbox. An item **already filed** elsewhere is not moved on
  weak terms alone ("the investor on this flip" is common); it moves only when Claude flags phalanx material.
- **Claude's `phalanx_material` flag on its own** (Claude chose another workspace but saw investor
  material) also sends the item to inbox with a phalanx review item, never to the other workspace.
  This is conservative: AnotherStory meetings that discuss raising money for AnotherStory wait for Ben.
  If that is too cautious, the right fix is a narrower prompt ("investor material *about Phalanx*").
  I did not narrow it because the brief says "investor/cap-table material goes to phalanx".
- **People who only exist in phalanx** (all their roles are phalanx) make a conversation phalanx at 0.85.
- **Items nobody can file confidently stay where they are.** An unassigned Zoom meeting stays unassigned
  (Ben's connector lists `unassigned`) instead of moving to inbox, where it would disappear from his
  connector. Only the phalanx guard moves things into inbox.
- **Mailbox rule:** ben@anotherstory.com → another_story and ben@stroutarch.com → strout_arch, at 0.9,
  ahead of participants and content (phalanx still first). stroubo@gmail.com gets no default.
- **Feasibility studies → another_story**, by title for recordings, and when Claude says strout_arch
  because it is a feasibility study. Also changed in the old title classifier (`rules.ts`).
- **Generic titles carry no signal** ("Ben Strout's Zoom Meeting", "Another Story's Zoom Meeting",
  "Another Story 37" voice memos, "Call Recording"). Many "Another Story N" voice memos turned out to be
  wound-care planning or personal.
- **Things with no workspace:** Ice Dream / Arctic Evermore (Ben's cold-plunge product) and his
  insurance-adjuster work. The classifiers put them in personal or (low-confidence) phalanx, which lands
  them in inbox for review. **Consider adding a workspace for Arctic Evermore.**
- **Church and commercial owner's-rep projects** (Greensport Baptist, Cornerstone Christian School) went
  to sepp when the content was owner's-rep work, even where Ben also draws plans.
- **The backfill's Claude read was done in this session**, not by the worker. This container cannot reach
  the app's Anthropic key, and the deployed worker runs the old code. Eight parallel Claude agents read the
  same excerpt (first 2,000 characters, `CLASSIFY_SYSTEM_PROMPT` verbatim) with read-only queries. Their
  verdicts went through the app's own `decideWorkspace()` (run locally), and the results were written in
  SQL. Every row is marked `classify_model = 'claude-session-backfill-2026-10-30'` and
  `classify_evidence.pass = 'session-backfill-2026-10-30'` (deterministic rows: `backfill-deterministic-2026-10-30`),
  with `from` = the previous workspace, so the whole pass can be reviewed or reverted as a set. No
  `spend_ledger` row was written for it: it was not billed to the app's API key.
- **Reverting** one item: set `workspace_id = classify_evidence->>'from'`. All of them:
  `update interactions set workspace_id = classify_evidence->>'from', classified_at = null where classify_evidence->>'pass' like '%backfill-2026-10-30'`.

**Extraction and facts**
- **Five types as asked, stored in the existing spellings**: commitment, task (new), follow_up → `followup`,
  decision, amount → `price`. MCP `list_open_commitments` already accepted all of them.
- **Facts are written directly at 0.8+** (`EXTRACT_FACT_MIN_CONFIDENCE`); 0.6–0.8 still go to Review.
  Speaker matches and project links still go to Review.
- **Existing proposals:** of the 1,560 open `new_fact` proposals the old extractor queued, those of kind
  commitment/followup/decision/price, at 0.8+, in a readable workspace and from the last 365 days were
  turned into facts (origin `backfill`, `source_review_id` set, proposal marked approved with
  `applied_as_fact`). issue/preference/other and lower-confidence ones stay on Review. Commitments from
  2022–2024 were not promoted: they would flood "open commitments" with things long since done.
- **Dedupe:** the model sees the open items already recorded for these people (or, with nobody known, the
  workspace's last 14 days) and can answer `same_as_fact_id`. Behind it, an open fact of the same kind,
  owner and workspace within 45 days with trigram similarity ≥ 0.55 is treated as the same promise.
  Either way the new conversation becomes a `fact_sources` row; due date, amount, project and "about"
  are filled in if the first mention lacked them.
- **Due dates** resolve from the local (America/Chicago) day the line was said: the start plus the
  line's offset. "next Friday" means Friday of next week (Monday–Sunday weeks); a past date resolves to null.
- **personal is extracted** (it is in Ben's scope now); follow-through does **not** chase personal threads
  with drafted replies. inbox is never extracted; phalanx only when `EXTRACT_WORKSPACES` lists it.
- **Unfiled recordings are no longer read under a guessed workspace.** The classifier files first
  (`EXTRACT_REQUIRE_CLASSIFIED=1`).
- **`jobs` stays, for transcribe only.** No new extract jobs, and the 225 orphans are `skipped`.
  Extraction state lives on the interaction (`extracted_at`, `extracted_through_idx`), as it already did.

**People**
- **Auto-link** only on an email or phone match, or an exact / first+last name match to exactly one person.
  One-word names ("Nea") never auto-link. Close names (trigram ≥ 0.5) become `participant_match` Review
  items. Ben (owner identifiers, his names) is never linked as the other participant.
- **Zoom participants API:** the Server-to-Server app has only `recording:read:admin` + `user:read:admin`.
  The link step tries `past_meetings/{uuid}/participants`; if the scope is missing it records that once
  (`worker_state.zoom_participants_api`) and skips for 7 days. **Adding `meeting:read:admin` (or
  `report:read:admin`) to the Zoom app** turns on the most reliable source.
- **Calendar attendees** come from the Meet account's existing `calendar.events.readonly` grant
  (ben@anotherstory.com); an event within 20 minutes of the Zoom start, preferring one that mentions Zoom.
- **"Call Recording" titles:** iOS writes no contact into those notes. The Mac collector now looks the
  call up in the Mac's call history by time and sends the number (`POST /api/ingest/device/participants`
  for calls already sent). The link step matches it and retitles "Call with <Name>". Until the collector
  update runs on the Mac, those calls have no number, so nothing was retitled in production.
- **Duplicate parties (same email): none exist.** No two parties share an email or a 10-digit phone.
  Nothing was merged. Name-level duplicates exist, e.g. #7 "Tanner Durfee" (no email), #1196
  "tannerdurfee@gmail.com" (a site lead) and tanner@designyourprice.com on the calendar. They are left
  alone because they do not share an email. `mergeParties()` is there for when Ben decides.

**Scope**
- **personal added** to the Claude connector's grant: `oauth_clients` 939f5f8d… and its live
  access/refresh tokens. The consent screen now ticks personal by default; phalanx and inbox are never
  ticked by default and never implied by "*". personal stays out of "*" so other tokens do not gain it.


## To finish (what only Ben can do)

1. **Pull and redeploy both Repls** (web app and worker) from `claude/new-session-5kvgow` once it is merged.
   Migration 0013 is already applied. Until then the deployed worker runs the old code. It keeps reading
   threads into Review proposals (not facts), and it has no `classify` or `link` step, so new texts,
   notes and calls land in inbox as before.
2. **Worker secret `CLASSIFY_MONTHLY_BUDGET_USD`**, e.g. `10`. New items are a few dozen a day, about
   $0.01 each on Opus 5.5 at low effort; `CLASSIFY_MODEL=claude-haiku-5-5` would be ~20x cheaper.
   Without it, the deterministic rules still file what they can and the rest waits.
3. **Optional: let the new extractor re-read the last 30 days** so they produce facts instead of proposals:
   `update interactions set extracted_at = null, extracted_through_idx = null where classified_at is not null and occurred_at > now() - interval '30 days' and workspace_id in ('another_story','strout_arch','southern_shutter','sepp','credvault','personal');`
   About 600 items at 2–8 cents each, inside the existing $100/month extract budget.
4. **Google Meet:** turn on recording and transcripts for ben@anotherstory.com (see the root cause above).
5. **Zoom app:** add `meeting:read:admin` (or `report:read:admin`) to the Server-to-Server OAuth app, so
   the link step gets real participant lists and emails.
6. **Mac:** `git pull` in the collector folder so the Apple-media collector reads the call log and fixes
   the 24 "Call Recording" titles. iPhone → Settings → Phone → Calls on Other Devices must be on for
   the Mac to have the log.
7. **5-minute cadence:** publish the light-steps Scheduled Deployment described above, if the cost is acceptable.
8. **Review:** 881 open workspace suggestions (123 of them phalanx), 7 close-name matches, 277 unknown
   senders. Bulk-approving the workspace suggestions at 0.5+ is reasonable. Leave the phalanx ones for a look.
