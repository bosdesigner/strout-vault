# Verification: every ingest point

| # | Artifact | Where |
|---|---|---|
| 1 | `--discover` output from the Mac (placeholder + the command), and the same command against fixture copies of each Apple database; parser tests against those fixtures (current and older column names, a mismatched schema that fails loudly) | [discover.md](discover.md), `tests/unit/apple-media.test.ts`, `tests/fixtures/apple-media/build.ts` |
| 2 | Endpoint tests: no token → 401, `ingest:messages` / `vault:read` token → 403 (and a device token is refused by `/api/ingest/messages` and `/mcp`), presign → PUT → finalize, the same file twice → one row (by `source_ref` and by SHA-256 across Mac and Shortcut), note upsert / unchanged / edit, `phalanx` never assigned even from explicit rules | `tests/api/device.test.ts`, [test-output.md](test-output.md) |
| 3 | Collector `--dry-run` against the fixtures (counts and bytes per source, no uploads) and the Apple files' SHA-256 before and after | [collector-dry-run.md](collector-dry-run.md) |
| 4 | One end-to-end run on the local database: voice memo, call recordings, notes (the real collector process), a Meet recording (mocked Drive + Calendar), the audio reaching `ready` through the transcribe step and everything embedded | [end-to-end.md](end-to-end.md), `tests/api/ingest-e2e.test.ts` |
| 5 | `curl` transcript of the Shortcut's three requests succeeding locally | [shortcut-curl.md](shortcut-curl.md) |
| 6 | The Sources panel with seeded data showing each status (live, configured but never run, not configured, erroring, a warning) | [sources-panel-1440.png](sources-panel-1440.png), [dark](sources-panel-dark-1440.png), [390 px](sources-panel-390.png); `tests/api/sources.test.ts` |
| 7 | Full test suite and typecheck | [test-output.md](test-output.md) |

Everything ran against a local Postgres (`npm run db:local`, migrations 0001–0010 + the seed) and the local storage
driver. Nothing connected to Neon, R2, Google or Groq.
