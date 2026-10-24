# Test output

`npm test` (Vitest: unit + API tests, 20 files) on 2026-10-24 against a fresh local Postgres 16.15 + pgvector 0.6.0.
The 16 pre-existing files are unchanged apart from the seed additions (`scripts/gen-seed.ts`: two cross-workspace
roles and five distinctive passages) and still pass; the four new files are `tests/unit/chunker.test.ts`,
`tests/unit/embeddings.test.ts`, `tests/unit/mcp-scope.test.ts` and `tests/api/mcp.test.ts`.

```
$ npm test
RUN  v3.2.7 /home/user/strout-vault

stdout | tests/api/phase3.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/phase3.test.ts > contractor login with magic links > rate-limits link requests
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/phase3.test.ts > twilio webhooks > refuses requests without a valid signature and when Twilio is not configured
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stderr | tests/api/phase3.test.ts > twilio webhooks > records a failed fetch on the call and returns 500 so Twilio retries
[twilio] recording ingest failed: Twilio returned 404 for the recording

 ✓ tests/api/phase3.test.ts (12 tests) 988ms
stdout | tests/api/phase2.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/phase2.test.ts (15 tests) 1027ms
stdout | tests/api/phase5.test.ts > cut > records a readable reason when there is nothing to cut from, and Try again resets it
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/phase5.test.ts > cut > clips API
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/phase5.test.ts (8 tests) 9778ms
   ✓ cut > renders an approved candidate into a 9:16 captioned MP4 in the upload bucket and records it  8025ms
   ✓ cut > records a readable reason when there is nothing to cut from, and Try again resets it  709ms
stdout | tests/api/worker.test.ts > pipeline API
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/worker.test.ts (9 tests) 6762ms
   ✓ worker run > skips the Zoom step when Zoom is not configured and still records a run  4546ms
   ✓ worker run > pulls new Zoom recordings into storage, verifies them, and transcribes with Zoom's VTT first  332ms
 ✓ tests/api/mcp.test.ts (30 tests) 6107ms
   ✓ audit log and rate limit > refuses the 61st call in a minute for one token, without affecting other tokens  352ms
   ✓ OAuth 2.1 for Claude.ai connectors > runs the whole flow: dynamic registration, PKCE, login + consent with workspace choice, code exchange, scoped tool calls, refresh rotation, replay detection and revocation  819ms
stdout | tests/api/auth.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/auth.test.ts > auth > rate-limits repeated failed logins per IP
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/auth.test.ts (10 tests) 3904ms
   ✓ auth > logs in with the right password and sets an httpOnly, SameSite=Lax cookie  305ms
   ✓ auth > accepts the email case-insensitively  307ms
   ✓ auth > rejects a wrong password and an unknown email the same way  647ms
   ✓ auth > lets a logged-in session read /api/auth/me and the library  354ms
   ✓ auth > requires the CSRF token on state-changing requests  342ms
   ✓ auth > logs out (with CSRF) and the cookie no longer works  319ms
   ✓ auth > rate-limits repeated failed logins per IP  1230ms
stdout | tests/api/upload.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stderr | tests/api/upload.test.ts > upload > rejects unsupported file types, bad keys and unauthenticated calls
Error: invalid storage key
    at assertSafeKey (/home/user/strout-vault/server/storage/types.ts:85:30)
    at finishUpload (/home/user/strout-vault/server/services/upload.ts:59:3)
    at /home/user/strout-vault/server/routes/uploads.ts:113:27
    at /home/user/strout-vault/server/routes/util.ts:18:5
    at Layer.handleRequest (/home/user/strout-vault/node_modules/router/lib/layer.js:152:17)
    at next (/home/user/strout-vault/node_modules/router/lib/route.js:157:13)
    at Route.dispatch (/home/user/strout-vault/node_modules/router/lib/route.js:117:3)
    at handle (/home/user/strout-vault/node_modules/router/index.js:435:11)
    at Layer.handleRequest (/home/user/strout-vault/node_modules/router/lib/layer.js:152:17)
    at /home/user/strout-vault/node_modules/router/index.js:295:15

 ✓ tests/api/upload.test.ts (6 tests) 871ms
stdout | tests/api/library.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/library.test.ts (13 tests) 927ms
stdout | tests/api/search.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/search.test.ts (8 tests) 843ms
 ✓ tests/unit/embeddings.test.ts (8 tests) 42ms
 ✓ tests/unit/chunker.test.ts (7 tests) 17ms
 ✓ tests/unit/zoomClient.test.ts (8 tests) 18ms
 ✓ tests/unit/mcp-scope.test.ts (7 tests) 10ms
 ✓ tests/unit/text.test.ts (12 tests) 8ms
 ✓ tests/unit/clips.test.ts (8 tests) 15ms
 ✓ tests/unit/vtt.test.ts (4 tests) 5ms
 ✓ tests/unit/videoSource.test.ts (13 tests) 4ms
 ✓ tests/unit/session.test.ts (3 tests) 4ms
 ✓ tests/unit/twilio.test.ts (4 tests) 6ms
 ✓ tests/unit/groq.test.ts (4 tests) 4ms

 Test Files  20 passed (20)
      Tests  189 passed (189)
   Start at  23:47:05
   Duration  43.39s (transform 1.17s, setup 0ms, collect 8.04s, tests 31.34s, environment 3ms, prepare 1.07s)
```

## End-to-end (Playwright)

`npm run test:e2e` (41 tests, desktop + iPhone projects) on the same day, with the repo's pinned Playwright 1.56.1
mapped onto the sandbox's installed Chromium 153:

```
  39 passed (1.3m)
  1 failed   [desktop] › tests/e2e/upload.spec.ts:7:3 › upload › upload a real video file and the rows exist
             (upload row stuck at data-status="hashing": the browser-side SHA-256 worker did not finish in 10 s)
  1 did not run (the serial follow-up in upload.spec.ts)
```

The upload spec passes when run on its own on this branch (`npx playwright test tests/e2e/upload.spec.ts
--project=desktop` → 3 passed) and fails the same way on `main` in this sandbox, so it is the environment
(browser version / CPU under the full run), not this change. Nothing in this PR touches the upload path.
