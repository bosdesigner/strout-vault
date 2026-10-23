# Phase 4 verification: the worker

Phase 4 moves meeting-vault's pipeline into Strout Vault. A single command,
`npm run worker`, does what `vault run` did on the Mac, against Neon and the
B2 bucket directly, and is meant to run hourly as a Replit Scheduled
Deployment (README, "Deploy the worker"). Everything below ran on
2026-10-23 against local Postgres, the local storage driver, a mock Zoom API
and a mock Groq endpoint. Nothing touched Neon, B2, R2, Zoom or Groq.

## What was built

| Piece | Where | Replaces in meeting-vault |
|---|---|---|
| Zoom Server-to-Server OAuth client: token, paged requests with 429/5xx backoff, month windows, per-user recordings de-duplicated by UUID, downloads with manual redirects (bearer token never leaves Zoom's host) | `server/worker/zoom.ts` | `vault/zoom.py` |
| Enumerate and download: interaction + pending media rows per recording, streamed into the archive bucket while hashing, byte count checked against Zoom's report (`verified` / `verified_stable` / `failed`), newest-first and small-files-first, time and byte budgets, up to 4 attempts per file | `server/worker/sync.ts` | `vault/download.py`, `vault/autorun.py` |
| Transcription: Zoom TRANSCRIPT, then CC, then Groq Whisper (16 kHz mono Opus, 15-minute chunks, word timings), one transaction per recording | `server/worker/transcribe.ts`, `vtt.ts`, `groq.ts`, `media.ts` | `vault/transcribe.py`, `vault/apistt.py` |
| Monthly budgets from a ledger: nothing goes to Groq unless `GROQ_API_KEY` and `GROQ_MONTHLY_BUDGET_USD` are both set and the estimate fits | `server/worker/budget.ts`, `spend_ledger` | `--budget` flags and the confirmation prompt |
| Run lock (Postgres advisory lock), `worker_runs` rows with per-step summaries, report | `server/worker/run.ts`, `report.ts` | `logs/run.lock`, `vault status`, `vault why` |
| Pipeline page (owner only): last runs, queue, waiting items with the reason, failed items with Retry, recordings without an off-site copy, spend vs budget | `server/routes/pipeline.ts`, `client/src/pages/PipelinePage.tsx` | the console / app status pane |
| Streaming server-side writes and reads on both storage drivers; `archiveTarget` (B2 when configured) | `server/storage/*` | `vault/coldstore.py` |
| Migration `0004_worker.sql` | `db/migrations/` | the SQLite manifest's `runs`, `kv` tables |

Not in this phase, by design: proxies and H.265 masters (B2 is instant and the
app already streams originals), clip scouting and cutting (Phase 5), Google
Meet and the iPhone share shortcut (Phases 6 and 7), fact extraction (the
`extract` jobs stay `pending`), and the final `vault pg-import` + Mac shutdown
(after the worker's first production runs look right).

## Hard rules, checked

- **No schema changes from app code.** Only `db/migrations/0004_worker.sql`, additive and re-runnable (`create table if not exists`, `add column if not exists`). The worker runs no DDL.
- **No deletes.** `grep -rn "delete from\|DeleteObject" server/` finds nothing. A mismatched download overwrites the same key. The only Zoom verbs are GET and the token POST.
- **No spend without consent.** `tests/api/worker.test.ts` "Recording C" shows a recording left `queued` with `waiting: groq monthly budget reached …` and no request made to the Groq mock. With `GROQ_MONTHLY_BUDGET_USD` unset, Groq is off entirely (`checkBudget` returns "groq is off").
- **Every page and route requires login.** `/api/pipeline` is mounted behind `requireAuth()` and `requireOwner()`; the e2e contractor test gets 403 and no menu item.
- **Tests never touch Neon, B2 or R2.** The worker test builds its own database (`strout_vault_worker`) and its own storage directory, and injects a fetch that only knows `zoom.test`, `cdn.test` and `groq.test`.

## 1. Unit and API tests

```
$ npm test
 ✓ tests/api/worker.test.ts (8 tests) 1920ms
 ✓ tests/api/auth.test.ts (10 tests)
 ✓ tests/api/upload.test.ts (6 tests)
 ✓ tests/api/phase3.test.ts (12 tests)
 ✓ tests/api/phase2.test.ts (15 tests)
 ✓ tests/api/library.test.ts (13 tests)
 ✓ tests/api/search.test.ts (8 tests)
 ✓ tests/unit/zoomClient.test.ts (8 tests)
 ✓ tests/unit/text.test.ts (12 tests)
 ✓ tests/unit/videoSource.test.ts (13 tests)
 ✓ tests/unit/groq.test.ts (4 tests)
 ✓ tests/unit/session.test.ts (3 tests)
 ✓ tests/unit/vtt.test.ts (4 tests)
 ✓ tests/unit/twilio.test.ts (4 tests)

 Test Files  14 passed (14)
      Tests  120 passed (120)
```

What the worker test proves (`tests/api/worker.test.ts`), against a mock Zoom
that paginates at two records, rate-limits one download once, redirects one to
a "CDN" host, reports one file size wrong and 404s one file:

- four recordings enumerated across two pages with one token; 8 files queued (the TIMELINE file is ignored), 6 `verified`, 1 `verified_stable` (the chat file whose reported size was wrong but whose SHA-256 was reproducible), 1 `failed` (404), bytes and SHA-256 in `media` match the fixture and the object in storage is byte-identical;
- the bearer token was not sent to the CDN host after the redirect (`cdnAuthHeaders === 0`);
- recording A was transcribed from Zoom's VTT: 3 segments with speakers, `transcripts.source = 'zoom_vtt'`, `interactions.transcript` rendered with timestamps, the `transcribe` job `done`, and a full-text search for "pelican roof tiles" hits it immediately (the `tsv` column is generated);
- recording B had audio only and went to Groq: 2 segments with word timings, one `spend_ledger` row of $0.0000333 (3 s at $0.04/hour);
- recording C would have exceeded the month's budget and stayed `queued` with the reason, and no Groq call was made for it;
- a second run with a larger budget created no new rows, retried only the 404 (attempts 2) and transcribed C;
- a transcript file Zoom "finished later" is picked up without touching the rest;
- a second run while one holds the lock is recorded as `skipped: locked`;
- with the time budget spent, enumeration still completes and no download starts;
- the pipeline API is 401 anonymous, 403 for contractors, lists runs and waiting items, and `POST /api/pipeline/retry` resets a failed upload (random bytes that ffprobe cannot read) to `queued` with the job back to `pending`.

## 2. End-to-end (Playwright)

```
$ npm run test:e2e
  31 passed, plus tests/e2e/phase4.spec.ts:
  ✓ [desktop] owner: pipeline page › shows the worker's status, the queue and what is waiting
  ✓ [desktop] contractor › cannot read the pipeline
  ✓ [iphone]  owner: pipeline page › shows the worker's status, the queue and what is waiting
  ✓ [iphone]  contractor › cannot read the pipeline
```

(One run of `upload.spec.ts` timed out while the SHA-256 worker compiled under
load from a parallel build; it passed on its own immediately after, 3.2 s.)

## 3. The built worker, locally

`npm run build` now also produces `dist/worker/index.js`. Against the seeded
local database (no Zoom credentials, no Groq key):

```
$ node dist/worker/index.js
[worker] storage=local, archive=local, groq=off
[worker] zoom: skipped (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set)
[worker] transcribe: 2 recording(s) waiting
[worker] transcribe:   Warehouse b-roll selects: FAILED no transcript file and no readable audio or video original
[worker] transcribe:   Ben Strout's Zoom Meeting: FAILED no transcript file and no readable audio or video original
[worker] run #1 finished in 0s
zoom: not configured
transcribe: 0/2 done (zoom transcript 0, captions 0, groq 0), 0 waiting on budget, 2 failed, $0.000 spent
queue: 0 queued, 0 transcribing, 3 failed, 37 ready; 0 download(s) pending; 9 recording(s) without an off-site copy; groq this month $0.00
```

(The two seed recordings fail honestly: their only originals are fake B2 keys
the local driver cannot read. In production the S3 driver reads B2 and R2.)

## 4. Screenshots

`SCREENSHOT_PHASE=phase-4 npm run screenshots` → [`docs/screenshots/phase-4/`](screenshots/phase-4/):
`pipeline-1440.png`, `pipeline-dark-1440.png`, `pipeline-390.png` (no horizontal overflow at 390 px).

## 5. Production data, read-only, before the switch

Queried on Neon on 2026-10-22 (SELECTs only), to confirm the Mac can be
retired without losing anything:

| | |
|---|---|
| Recordings | 1,186 (1,179 Zoom, 7 uploads), 1,185 ready |
| B2 originals, verified | 1,187 video, 1,180 audio, 193 chat, 20 captions (283.5 GB in `media.bytes`) |
| Local-only copies | 1,185 proxies on the Mac; every original there is `deleted_local` (already pruned after B2 verification) |
| Recordings with no off-site audio/video | 1: "Aaron Murphy Another Story initial phone call" (2023-01-02), which has no media rows at all |
| Transcripts | 1,165 Groq, 20 Zoom VTT (396,956 segments) |
| Latest Zoom recording | 2026-10-16 |

The worker's first production run will re-list the last three months and
match those recordings by UUID, so it downloads nothing twice.

## Migration to apply

`db/migrations/0004_worker.sql` (10 statements: 3 tables, 3 indexes, 2 columns on `media`, 1 index, 1 `schema_log` row). `/api/health` then reports `v0.4 worker: …`.
