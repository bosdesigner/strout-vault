# Phase 1 verification

Evidence for the Phase 1 pull request. Everything below ran against a local
PostgreSQL 16 and the `local` storage driver; nothing touched Neon, B2 or R2.

## 1. Unit and API tests (`npm test`)

65 tests across 7 files, all passing. They cover auth (login, logout, wrong
password, rate limit, CSRF, unauthenticated requests rejected), search
(phrases, `OR`, exclusion, filters, grouping, highlighting), the video-source
selection rules, the library listing and cursor pagination, recording edits
and clip approval, and the upload-complete transaction (rows created, rolled
back on failure, duplicate SHA-256 refused).

```
 ✓ tests/api/auth.test.ts (10 tests) 3819ms
 ✓ tests/api/library.test.ts (13 tests) 912ms
 ✓ tests/api/upload.test.ts (6 tests) 912ms
 ✓ tests/api/search.test.ts (8 tests) 876ms
 ✓ tests/unit/text.test.ts (12 tests) 9ms
 ✓ tests/unit/videoSource.test.ts (13 tests) 9ms
 ✓ tests/unit/session.test.ts (3 tests) 4ms

 Test Files  7 passed (7)
      Tests  65 passed (65)
```

## 2. End-to-end tests (`npm run test:e2e`)

Playwright against the seeded local database and the `local` storage driver,
on Desktop Chrome and an iPhone 13 viewport (library and recording specs run
on both). The upload test uses a real 8-second MP4 (`tests/e2e/fixtures/upload-test.mp4`).

```
  ✓   1 [setup] › tests/e2e/auth.setup.ts:6:1 › log in (2.9s)
  ✓   2 [desktop] › tests/e2e/library.spec.ts:4:3 › library › shows recordings newest first and filters by year (1.7s)
  ✓   3 [desktop] › tests/e2e/library.spec.ts:35:3 › library › never scrolls sideways (904ms)
  ✓   4 [desktop] › tests/e2e/recording.spec.ts:8:1 › edit a title inline and it persists (1.5s)
  ✓   5 [desktop] › tests/e2e/recording.spec.ts:27:1 › approve a clip candidate (1.4s)
  ✓   6 [desktop] › tests/e2e/recording.spec.ts:46:1 › clicking a transcript line seeks the video; find-in-transcript counts matches (1.3s)
  ✓   7 [desktop] › tests/e2e/recording.spec.ts:61:1 › recording page has no horizontal overflow (1.1s)
  ✓   8 [desktop] › tests/e2e/search.spec.ts:3:1 › search a seeded phrase, open the hit and land on the right second with the video seeked (1.4s)
  ✓   9 [desktop] › tests/e2e/search.spec.ts:33:1 › phrase, OR and exclusion syntax (1.4s)
  ✓  10 [desktop] › tests/e2e/upload.spec.ts:7:3 › upload › upload a real video file and the rows exist (3.5s)
  ✓  11 [desktop] › tests/e2e/upload.spec.ts:51:3 › upload › re-uploading the same file is refused as a duplicate (1.3s)
  ✓  12 [iphone] › tests/e2e/library.spec.ts:4:3 › library › shows recordings newest first and filters by year (1.7s)
  ✓  13 [iphone] › tests/e2e/library.spec.ts:35:3 › library › never scrolls sideways (776ms)
  ✓  14 [iphone] › tests/e2e/recording.spec.ts:8:1 › edit a title inline and it persists (1.4s)
  ✓  15 [iphone] › tests/e2e/recording.spec.ts:27:1 › approve a clip candidate (1.4s)
  ✓  16 [iphone] › tests/e2e/recording.spec.ts:46:1 › clicking a transcript line seeks the video; find-in-transcript counts matches (1.3s)
  ✓  17 [iphone] › tests/e2e/recording.spec.ts:61:1 › recording page has no horizontal overflow (1.0s)
  17 passed (33.6s)
```

What each one checks:

- **log in** — wrong password shows an error; right password lands on the library.
- **library** — cards are newest first, generic titles show a preview line, the Year select filters to 2024, Clear restores everything; no horizontal scrolling at 1440 or 390.
- **search** — press `/`, search `pelican roof tiles`, one group, highlighted words, click the 0:42 line, land on `/r/:id?t=42` with the `<video>` seeked to 42 s and that transcript line active. Also `"gutters copper"` (no match), `skylight OR dormer`, `shutters -cedar`.
- **upload** — pick a real MP4, set title/source/workspace/person, upload; then via the API: `interactions` row `queued`, `media` row `local`/`original`/`verified` under `uploads/yyyy/mm/uuid/`, two `pending` jobs, the participant. The library shows the new card with a *Queued* chip.
- **duplicate** — the same file again is stopped before upload with "Already in the vault: E2E uploaded call" and a link to it.
- **edit a title** — inline edit persists across reload.
- **approve a clip** — status goes `new` → `approved` and persists.

## 3. Screenshots

Every Phase 1 page at 1440 px and 390 px (iPhone width), plus dark mode at
1440 px, in [`docs/screenshots/phase-1/`](screenshots/phase-1/). Produced by
`npm run screenshots`, which also reports any page whose `scrollWidth`
exceeds the viewport (none did).

| page | 1440 | 390 |
|---|---|---|
| Login | [login-1440](screenshots/phase-1/login-1440.png) | [login-390](screenshots/phase-1/login-390.png) |
| Library | [library-1440](screenshots/phase-1/library-1440.png) · [dark](screenshots/phase-1/library-dark-1440.png) | [library-390](screenshots/phase-1/library-390.png) |
| Library, filtered (2024, Zoom) | [library-filtered-1440](screenshots/phase-1/library-filtered-1440.png) | [library-filtered-390](screenshots/phase-1/library-filtered-390.png) |
| Recording (`?t=42`) | [recording-1440](screenshots/phase-1/recording-1440.png) · [dark](screenshots/phase-1/recording-dark-1440.png) | [recording-390](screenshots/phase-1/recording-390.png) |
| Recording, Clips tab | [recording-clips-1440](screenshots/phase-1/recording-clips-1440.png) | [recording-clips-390](screenshots/phase-1/recording-clips-390.png) |
| Recording, Details tab | [recording-details-1440](screenshots/phase-1/recording-details-1440.png) | [recording-details-390](screenshots/phase-1/recording-details-390.png) |
| Search (`"copper gutters"`) | [search-1440](screenshots/phase-1/search-1440.png) · [dark](screenshots/phase-1/search-dark-1440.png) | [search-390](screenshots/phase-1/search-390.png) |
| Upload dialog | [upload-1440](screenshots/phase-1/upload-1440.png) | [upload-390](screenshots/phase-1/upload-390.png) |
| Upload dialog with a file queued | [upload-queued-1440](screenshots/phase-1/upload-queued-1440.png) | [upload-queued-390](screenshots/phase-1/upload-queued-390.png) |
| Person (Phase 1 minimal) | [person-1440](screenshots/phase-1/person-1440.png) | [person-390](screenshots/phase-1/person-390.png) |

Things fixed after looking at them: the recording page overflowed sideways at
390 px (tab strip and long storage keys), the transcript disappeared under the
sticky video on phones (it is now the first tab, under a sticky player), the
Year select truncated its label, and the two-row mobile header was compacted
to one row.

## 4. Clean clone: `npm run build && npm start`, `/healthz`

Fresh `git clone` into an empty directory, then:

```
$ npm ci
added 403 packages in 6s
$ npm run build
../dist/client/index.html   1.09 kB │ gzip: 0.56 kB
✓ built in 4.17s            (dist/server/index.js, dist/client/)
$ NODE_ENV=production PORT=3555 DATABASE_URL=postgres://…@127.0.0.1:54329/strout_vault STORAGE_DRIVER=local … npm start

$ curl localhost:3555/healthz
{"db":"ok","storage":"ok","storageDriver":"local","schema":{"version":"v0.2 recordings: interactions/media extended, transcripts, segments (tsvector), clip_candidates, clips, import_runs","appliedAt":"2026-10-21T19:32:34.677Z","entries":1}}
$ curl -o /dev/null -w "%{http_code} %{content_type}" localhost:3555/r/38        # deep link serves the SPA shell
200 text/html; charset=utf-8
$ curl -o /dev/null -w "%{http_code}" localhost:3555/api/interactions          # every API route needs a login
401
$ curl -o /dev/null -w "%{http_code} %header{cache-control}" localhost:3555/assets/index-<hash>.js
200 public, max-age=31536000, immutable
```

Logging in through the built server and listing the library worked the same
as in development.

## 5. Search `EXPLAIN ANALYZE` on 400k segments

`npm run db:bench` generates 1,200 recordings / 400,800 segments with a
realistic vocabulary and runs `EXPLAIN (ANALYZE, BUFFERS)` on the exact SQL
the endpoint uses. Full plans: [`docs/search-explain-analyze.md`](search-explain-analyze.md).

| query | groups on page 1 | wall time (endpoint, warm) | EXPLAIN execution time |
|---|---|---|---|
| `permit schedule` | 20 | 21.9 ms | 36.4 ms |
| `"copper gutter"` | 20 | 25.3 ms | 29.5 ms |
| `skylight OR dormer` | 20 | 89.5 ms | 92.5 ms |
| `shutter -cedar` | 20 | 71.1 ms | 65.7 ms |
| `permit` (very common word) | 20 | 51.0 ms | 53.7 ms |
| `contractor invoice` + workspace + date range | 20 | 22.4 ms | 20.5 ms |
| `drone footage` + person | 20 | 21.5 ms | 20.7 ms |

Every plan starts from a `Bitmap Index Scan on segments_tsv` (the GIN index
from `0002_recordings.sql`); the worst case (`OR` of two common words) is
92 ms, under the 300 ms budget with room to spare. Neon's smallest compute is
slower than this laptop-class container, but not by 3×; if it ever gets close,
the per-group `ts_headline` is the first thing to cache.
