# Test suite and typecheck

Local Postgres 16 with pgvector, Node v22.22.0, 2026-10-27.

```
$ npm run typecheck
> strout-vault@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p client/tsconfig.json --noEmit

(exit 0)

$ npm test
 ✓ tests/api/phase5.test.ts (8 tests) 12959ms
 ✓ tests/api/worker.test.ts (9 tests) 9150ms
 ✓ tests/api/mcp.test.ts (30 tests) 8641ms
 ✓ tests/api/ingest-e2e.test.ts (9 tests) 6538ms
 ✓ tests/api/messages.test.ts (17 tests) 7247ms
 ✓ tests/api/auth.test.ts (10 tests) 4518ms
 ✓ tests/unit/apple-media.test.ts (12 tests) 3628ms
 ✓ tests/api/workspaces.test.ts (6 tests) 2776ms
 ✓ tests/api/device.test.ts (15 tests) 2574ms
 ✓ tests/api/sources.test.ts (5 tests) 1570ms
 ✓ tests/api/phase3.test.ts (12 tests) 1211ms
 ✓ tests/api/phase2.test.ts (15 tests) 1265ms
 ✓ tests/api/library.test.ts (13 tests) 1058ms
 ✓ tests/api/upload.test.ts (6 tests) 1021ms
 ✓ tests/api/extract.test.ts (13 tests) 1104ms
 ✓ tests/api/leads.test.ts (8 tests) 1049ms
 ✓ tests/api/search.test.ts (8 tests) 955ms
 ✓ tests/unit/messages.test.ts (18 tests) 137ms
 ✓ tests/unit/zoomClient.test.ts (8 tests) 19ms
 ✓ tests/unit/embeddings.test.ts (8 tests) 55ms
 ✓ tests/unit/chunker.test.ts (7 tests) 23ms
 ✓ tests/unit/text.test.ts (12 tests) 10ms
 ✓ tests/unit/clips.test.ts (8 tests) 8ms
 ✓ tests/unit/workspaces.test.ts (5 tests) 9ms
 ✓ tests/unit/mcp-scope.test.ts (7 tests) 11ms
 ✓ tests/unit/videoSource.test.ts (13 tests) 8ms
 ✓ tests/unit/extract.test.ts (5 tests) 8ms
 ✓ tests/unit/vtt.test.ts (4 tests) 6ms
 ✓ tests/unit/twilio.test.ts (4 tests) 7ms
 ✓ tests/unit/session.test.ts (3 tests) 7ms
 ✓ tests/unit/groq.test.ts (4 tests) 8ms
 Test Files  31 passed (31)
      Tests  302 passed (302)
   Duration  94.87s (transform 1.88s, setup 0ms, collect 19.57s, tests 67.58s, environment 7ms, prepare 2.27s)
```
