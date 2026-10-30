# Phase 1 (v2) verification: routing, extraction, linking

Production is Neon `relationship-engine` (`dry-snow-01633657`, branch `main`). The "before" numbers were
read at 2026-10-30 00:48 UTC, before any change. The "after" numbers and the MCP output were read after
the backfill described below. The map of how things worked before is [phase1-map.md](phase1-map.md).

__SUMMARY__

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

__COUNTS__

__MCP__

__LEAK__

__FACTS__

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

__TESTS__

__DECISIONS__
