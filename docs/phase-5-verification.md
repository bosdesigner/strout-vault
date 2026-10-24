# Phase 5 verification: clips

Phase 5 moves meeting-vault's clip pipeline into the worker: Claude scouts new
transcripts for clip-worthy moments, the owner reviews them at `/clips`, and
ffmpeg renders approved ones into 9:16 captioned MP4s in the upload bucket,
downloadable from the app. Everything below ran on 2026-10-24 against local
Postgres, the local storage driver, a mock Anthropic endpoint and the real
ffmpeg 6.1 on the seeded sample video. Nothing touched Neon, B2, R2 or the
Anthropic API.

## What was built

| Piece | Where | Replaces in meeting-vault |
|---|---|---|
| Scout: 25-minute transcript chunks to Claude through the Anthropic SDK (`claude-opus-5-5`, `medium` effort, structured output with a Zod schema, cached system prompt, server-side refusal fallback); guardrails drop candidates outside the chunk, under 5 s, over 120 s or already reviewed; `scouted_at` per recording; actual usage priced into `spend_ledger` | `server/worker/scout.ts` | `vault/scout.py` |
| Monthly budget for Claude, same mechanism as Groq: nothing is sent unless `ANTHROPIC_API_KEY` and `SCOUT_MONTHLY_BUDGET_USD` are set and the estimate fits | `budget.ts`, `spend_ledger` | `--budget`, the confirmation prompt |
| Cut: approved candidates rendered from the full-quality original over a presigned URL (ffmpeg seeks instead of downloading), 1 s padding, 9:16 centre crop to 1080x1920 or the whole frame, captions burned in with libass from word timings (synthesized from cue timings when absent), H.264 High / AAC / `+faststart`; MP4 to `clips/<yyyy>/<mm>/<id>_<hook>.mp4`; `media` (role `clip`) + `clips` rows; candidate `cut` with `clip_media_id`; failures recorded and retried up to three times | `server/worker/cut.ts`, `captions.ts`, `media.ts` | `vault/clip.py`, `vault/cutter.py` |
| Caption font shipped with the repo (DejaVu Sans Bold, its licence alongside) so rendering does not depend on the host's fonts | `server/worker/assets/fonts/` | the Mac's system fonts |
| Clips page: To review (best score first, keyboard `j`/`k`/`a`/`r`/`o`), Approved (render state, Try again), Finished (Download); Clips in the nav and the phone tab bar; Download on the recording page's Clips tab | `client/src/pages/ClipsPage.tsx`, `server/routes/clips.ts` | the console's review station and finished-clips list |
| Pipeline page and report count candidates, renders and Claude spend; the run log shows scout and clip lines | `report.ts`, `run.ts`, `routes/pipeline.ts` | `vault status` |
| Migration `0005_clips.sql` | `db/migrations/` | manifest columns |

Not in this phase, by design: a "scout this recording now" button (scouting is
automatic for every new transcript; a re-scan can come later), clip formats
beyond vertical/full, and the Google Meet and iPhone sources (Phases 6 and 7).

## Hard rules, checked

- **No schema changes from app code.** Only `0005_clips.sql`, additive and re-runnable.
- **No deletes.** The scout and cutter only insert and update; a failed render leaves the candidate `approved` with a reason.
- **No spend without consent.** `tests/api/phase5.test.ts` shows: scouting off with no budget (no request made), the budget stopping the step with `waiting: anthropic monthly budget reached …` on the recording and no request made, and the monthly ledger rows that the Pipeline page sums.
- **Every route behind login.** `/api/clips` is owner-only (401 anonymous, 403 contractor in the browser test).
- **Tests never touch Neon, B2, R2 or Anthropic.** The Phase 5 test uses its own database and storage directory; its fetch knows only `anthropic.test`.

## 1. Unit and API tests

```
$ npm test
 ✓ tests/api/phase5.test.ts (8 tests) 11498ms
 ✓ tests/api/worker.test.ts (9 tests)
 ✓ tests/unit/clips.test.ts (8 tests)
 … 13 more files unchanged
 Test Files  16 passed (16)
      Tests  137 passed (137)
```

`tests/unit/clips.test.ts`: caption grouping (24 characters, 5 words, 0.7 s silence splits, no overlaps), synthesized word timings, the ASS file and escaping, the 9:16 crop arithmetic for landscape and portrait sources, transcript chunking and stamped lines, the candidate guardrails, cost from list prices and from usage, clip naming.

`tests/api/phase5.test.ts`, against a mock Claude that answers each chunk with one in-range candidate and one with invented timestamps:

- off without a budget: no request made, the summary says how many recordings are waiting;
- with a $5 budget and 3 recordings per run: 3 recordings read, every stored candidate inside its transcript's time range with score, platforms and the model, the invented ones dropped, `scouted_at` set, one `spend_ledger` row per recording; the request carried `claude-opus-5-5`, `medium` effort, the structured-output format, the cached system prompt and the `server-side-fallback-2026-07-01` beta;
- a budget of a fraction of a cent: the step stops before calling, the next recording says `waiting: anthropic monthly budget reached …`;
- a refusal: an empty answer, the recording still counts as scouted;
- a wrong key: one failure and the run stops instead of failing every recording;
- **render**: an approved candidate on the seeded sample video becomes a 1080x1920 H.264 MP4 with AAC audio and burned-in captions, 22 s long (20 s plus 1 s padding each side, measured with ffprobe), stored under `clips/2026/06/<id>_a-moment-from-the-sample-video.mp4` with matching `media` (role `clip`, verified, SHA-256, derived from the original) and `clips` rows, and the candidate `cut`;
- a recording whose video the worker cannot read: `render_error` names it, one attempt counted, status stays `approved`; `POST /api/clips/:id/rerender` resets it;
- the clips API: lists by status with counts, best score first; approving stamps `approved_at`; a cut clip cannot be moved back; `GET /api/clips/:id/download` hands out a URL that serves the exact bytes; unrendered clips get 404; the recording detail marks downloadable candidates; the Pipeline report counts clips and Claude spend and shows the worker's clip settings.

A frame from the rendered test clip, captions at the bottom of the 9:16 frame:
the caption reads "I will confirm with the", white DejaVu Sans Bold with a
dark outline over the sample video.

## 2. End-to-end (Playwright)

```
$ npm run test:e2e
  35 existing + tests/e2e/phase5.spec.ts on desktop and iPhone:
  ✓ owner: clips › reviews candidates with the keyboard and sees approved and finished tabs
  ✓ owner: clips › the recording page shows candidates and the clips link opens the moment
  ✓ contractor › cannot read or change clips
```

## 3. Screenshots

`SCREENSHOT_PHASE=phase-5 npm run screenshots` → [`docs/screenshots/phase-5/`](screenshots/phase-5/):
`clips-1440.png`, `clips-dark-1440.png`, `clips-approved-1440.png`, `clips-390.png`, `clips-approved-390.png`. At 390 px the card stacks its text above the buttons; no horizontal overflow.

## 4. What the backlog would cost

Read-only on Neon (2026-10-23): 990 transcribed recordings have never been
scouted, 4.27 million words in all. At Opus 5.5 list prices that is roughly
$30 to $35 for the whole backlog (about 7.5 million input tokens plus a small
amount of output), or about 5 cents per transcript hour going forward. The
worker reads newest-first, 20 recordings per hourly run, and stops for the
month when the budget is reached, so the monthly budget sets the pace.

## Migration to apply

`db/migrations/0005_clips.sql` (3 statements: two `alter table … add column if not exists`, one index, one `schema_log` row). `/api/health` then reports `v0.5 clips: …`.
