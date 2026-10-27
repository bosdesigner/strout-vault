# End to end on the local database

`tests/api/ingest-e2e.test.ts`, run with `VERIFY_OUT=docs/ingest-verification`. One local Postgres (the seed plus what
the run adds), the vault listening on :3995 with `STORAGE_DRIVER=local`, and nothing reaching Google, Groq, R2 or Neon:

1. The **real collector process** (`node collectors/apple-media/collector.mjs --backfill`) reads the fixture Voice Memos
   and Notes databases and posts to the vault: 1 voice memo, 2 call recordings (Notes "Call Recordings"), 2 notes.
   A second run sends nothing; a run with its state file deleted gets `duplicate` / `unchanged` for every item.
2. A **Google Meet** account connected through `/api/messages/meet/callback` (a grant with `drive.readonly` was
   refused first), then the worker's `meet` step against a fake Drive + Calendar: 1 recording with its transcript
   Doc and a calendar event naming Kevin; a second connected account with no recordings is marked `none_found`.
3. The worker's `transcribe` step (Groq mocked; ffmpeg real) and `embed` step (`EMBEDDING_PROVIDER=fake`).

## The resulting `interactions` rows

| id | source | kind | source_ref | workspace_id | title | pipeline_status | transcript_source | segments | chunks | embedded |
|---|---|---|---|---|---|---|---|---|---|---|
| 41 | voice_memo | recording | voice_memo:A1B2C3D4-0000-4000-8000-000000000001 | inbox | Porch idea | ready | groq | 2 | 1 | true |
| 42 | iphone_call | call | notes:NOTE-0015-CALL:ATT-0200-CALL | another_story | Call with Kevin McGuire | ready | groq | 2 | 1 | true |
| 43 | iphone_call | call | notes:NOTE-0016-CALL:ATT-0201-CALL | inbox | +1 (214) 555-0166 | ready | groq | 2 | 1 | true |
| 44 | apple_note | note | apple_note:NOTE-0010-LONG | inbox | Woodlands porch | ready | — | 1 | 1 | true |
| 45 | apple_note | note | apple_note:NOTE-0017-AUDI | another_story | Shoot day voice note | ready | — | 1 | 1 | true |
| 46 | meet | meeting | meet:ben@example.com:drive-rec-0001 | another_story | Conroe shoot planning | ready | meet_doc | 4 | 1 | true |

Worker transcribe step: {"candidates":6,"done":4,"viaZoomTranscript":0,"viaZoomCaptions":0,"viaMeetTranscript":1,"viaGroq":3,"waitingOnBudget":0,"failed":2,"spentUsd":0.0002,"errors":["Warehouse b-roll selects: no transcript file and no readable audio or video original","Ben Strout's Zoom Meeting: no transcript file and no readable audio or video original"]}

Embed step: {"done":43,"chunks":833}

The two `failed` in the transcribe summary are two of the seed's own sample recordings that have no readable media
(they fail the same way on `main`); the four new audio items all reached `ready` with a transcript. Notes have no
transcript row by design (text, no media) and are embedded straight away. Kevin's call and the Meet recording were
filed under `another_story` (his only workspace); the `+1 (214) 555-0166` call matched Daniel, whose only workspace is
`phalanx`, so it went to `inbox` with a `workspace_assignment` review row suggesting phalanx.
