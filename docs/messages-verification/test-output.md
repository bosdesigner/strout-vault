# Test run output

Run on 2026-10-26 in a cloud container against a local Postgres 16 with pgvector (`tests/global-setup.ts`;
nothing reaches Neon, Google or an embedding API). Typecheck (`npm run typecheck`) and `npm run build` were
clean on the same tree.

## The new suites, verbose

`tests/unit/messages.test.ts` (redaction, identifiers, filters, thread shape, the collector, Gmail parsing) and
`tests/api/messages.test.ts` (endpoint + token, idempotency, redaction across every table and every log line,
party matching, routing, unknown senders, MCP scope, review, the Gmail sync against a fake Gmail API).

```
RUN  v3.2.7 /home/user/strout-vault

 ✓ tests/api/messages.test.ts > the ingest:messages token > is the only thing POST /api/ingest/messages accepts
 ✓ tests/api/messages.test.ts > the ingest:messages token > cannot call MCP tools or read anything
 ✓ tests/api/messages.test.ts > texts from the collector > imports the synthetic chat.db; a second import of the same batch writes nothing
 ✓ tests/api/messages.test.ts > texts from the collector > stores no card number, SSN or one-time code in any table or log line
 ✓ tests/api/messages.test.ts > texts from the collector > writes one text_thread per conversation per Chicago day, transcript as [HH:MM] Name: text
 ✓ tests/api/messages.test.ts > texts from the collector > resolves (205) 555-0142, +12055550142 and 205.555.0142 to the same party
 ✓ tests/api/messages.test.ts > texts from the collector > routes: another_story by role, phalanx never automatic, personal by rule, unknown to inbox
 ✓ tests/api/messages.test.ts > texts from the collector > queues each unknown sender once for review and never creates a party
 ✓ tests/api/messages.test.ts > texts from the collector > merges a later batch into the same day's thread and re-triggers embedding
 ✓ tests/api/messages.test.ts > MCP tools on texts > an Another Story token finds Kevin's texts and nothing from personal, inbox or phalanx
 ✓ tests/api/messages.test.ts > MCP tools on texts > a token that names personal, inbox and phalanx sees them
 ✓ tests/api/messages.test.ts > review decisions on message proposals > approving an unknown sender creates the party and links their messages; approving a workspace files the thread
 ✓ tests/api/messages.test.ts > Gmail > initialises an account from the profile without fetching history
 ✓ tests/api/messages.test.ts > Gmail > syncs from history.list: filters categories, List-Unsubscribe, blocklist and codes before storage
 ✓ tests/api/messages.test.ts > Gmail > a new message updates the same thread (quoted reply stripped) and re-triggers embedding
 ✓ tests/api/messages.test.ts > Gmail > falls back to messages.list when Google has expired the historyId
 ✓ tests/api/messages.test.ts > Gmail > backfills resumably; a dry run writes nothing at all
 ✓ tests/unit/messages.test.ts > redaction > replaces Luhn-valid card numbers, SSNs and bank routing/account numbers with [REDACTED]
 ✓ tests/unit/messages.test.ts > redaction > leaves ordinary numbers alone: phone numbers, prices, dates, a non-Luhn 16-digit id
 ✓ tests/unit/messages.test.ts > redaction > checks the ABA checksum
 ✓ tests/unit/messages.test.ts > redaction > recognises one-time codes and redacts only the code in long emails
 ✓ tests/unit/messages.test.ts > identifiers > normalises (205) 555-0142, +12055550142 and 205.555.0142 to the same E.164 number
 ✓ tests/unit/messages.test.ts > identifiers > lowercases emails, recognises short codes, and tells Ben apart
 ✓ tests/unit/messages.test.ts > filtering before storage > skips short codes and one-time codes in texts
 ✓ tests/unit/messages.test.ts > filtering before storage > skips Gmail categories, List-Unsubscribe mail, drafts, spam and blocklisted senders
 ✓ tests/unit/messages.test.ts > filtering before storage > reads routing rules: party id and email domain to workspace
 ✓ tests/unit/messages.test.ts > filtering before storage > ships config files with commented examples only
 ✓ tests/unit/messages.test.ts > thread shape > groups texts per conversation per America/Chicago day
 ✓ tests/unit/messages.test.ts > thread shape > hashes message ids and bodies independent of order and line endings
 ✓ tests/unit/messages.test.ts > thread shape > encrypts refresh tokens with AES-256-GCM and refuses a wrong key
 ✓ tests/unit/messages.test.ts > iMessage collector > converts Apple epoch timestamps (nanoseconds and legacy seconds since 2001-01-01)
 ✓ tests/unit/messages.test.ts > iMessage collector > decodes attributedBody (typedstream NSAttributedString) when text is null
 ✓ tests/unit/messages.test.ts > iMessage collector > reads a synthetic chat.db from a read-only copy and skips short codes, codes, reactions and events
 ✓ tests/unit/messages.test.ts > Gmail parsing > keeps the plain-text part only, strips the quoted reply and signature, and keeps attachments as metadata
 ✓ tests/unit/messages.test.ts > Gmail parsing > strips 'Sent from my iPhone' and splits address lists on unquoted commas only

 Test Files  2 passed (2)
      Tests  35 passed (35)
   Start at  13:13:29
   Duration  15.04s (transform 1.78s, setup 0ms, collect 3.28s, tests 9.74s, environment 1ms, prepare 188ms)
```

## The whole suite

Two existing expectations changed on purpose: `/api/workspaces` now lists `inbox` and `personal`
(tests/api/library.test.ts), and `describeScope(["*"])` now reads "all workspaces except phalanx, personal,
inbox" (tests/api/workspaces.test.ts).

```
RUN  v3.2.7 /home/user/strout-vault

stdout | tests/api/phase5.test.ts > cut > records a readable reason when there is nothing to cut from, and Try again resets it
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/phase5.test.ts > cut > clips API
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/phase5.test.ts (8 tests) 19444ms
   ✓ cut > renders an approved candidate into a 9:16 captioned MP4 in the upload bucket and records it  16381ms
   ✓ cut > records a readable reason when there is nothing to cut from, and Try again resets it  1291ms
stdout | tests/api/worker.test.ts > pipeline API
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/worker.test.ts (9 tests) 16038ms
   ✓ worker run > skips the Zoom step when Zoom is not configured and still records a run  11755ms
   ✓ worker run > pulls new Zoom recordings into storage, verifies them, and transcribes with Zoom's VTT first  648ms
   ✓ worker run > is idempotent: a second run creates nothing new and only retries what failed  340ms
   ✓ pipeline API > marks a broken upload failed and Retry puts it back in the queue  522ms
 ✓ tests/api/mcp.test.ts (30 tests) 12404ms
   ✓ workspace scope > a token scoped to another_story gets zero phalanx results from every tool and every search mode  450ms
   ✓ audit log and rate limit > refuses the 61st call in a minute for one token, without affecting other tokens  729ms
   ✓ OAuth 2.1 for Claude.ai connectors > runs the whole flow: dynamic registration, PKCE, login + consent with workspace choice, code exchange, scoped tool calls, refresh rotation, replay detection and revocation  1235ms
   ✓ embedding pipeline > the worker's embed step embeds pending recordings, records failures without touching pipeline_status, and is resumable  318ms
 ✓ tests/api/messages.test.ts (17 tests) 9876ms
   ✓ texts from the collector > merges a later batch into the same day's thread and re-triggers embedding  5735ms
   ✓ MCP tools on texts > an Another Story token finds Kevin's texts and nothing from personal, inbox or phalanx  737ms
   ✓ Gmail > syncs from history.list: filters categories, List-Unsubscribe, blocklist and codes before storage  523ms
stdout | tests/api/auth.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stdout | tests/api/auth.test.ts > auth > rate-limits repeated failed logins per IP
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/auth.test.ts (10 tests) 5555ms
   ✓ auth > logs in with the right password and sets an httpOnly, SameSite=Lax cookie  398ms
   ✓ auth > accepts the email case-insensitively  456ms
   ✓ auth > rejects a wrong password and an unknown email the same way  1026ms
   ✓ auth > lets a logged-in session read /api/auth/me and the library  497ms
   ✓ auth > requires the CSRF token on state-changing requests  602ms
   ✓ auth > logs out (with CSRF) and the cookie no longer works  367ms
   ✓ auth > rate-limits repeated failed logins per IP  1520ms
stdout | tests/api/workspaces.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)

 ✓ tests/api/workspaces.test.ts (6 tests) 3864ms
   ✓ workspace proposer > gathers title, people and transcript signals for every unassigned recording  509ms
   ✓ workspace proposer > dry run proposes the obvious ones with evidence, leaves the rest undecided, and writes nothing  553ms
   ✓ workspace proposer > apply queues review items once; approving one files the recording, bulk approves the rest  723ms
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

 ✓ tests/api/phase3.test.ts (12 tests) 1515ms
stdout | tests/api/phase2.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/phase2.test.ts (15 tests) 1493ms
 ✓ tests/api/leads.test.ts (8 tests) 1515ms
 ✓ tests/api/extract.test.ts (13 tests) 1283ms
stdout | tests/api/library.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/library.test.ts (13 tests) 1432ms
stdout | tests/api/upload.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

stderr | tests/api/upload.test.ts > upload > rejects unsupported file types, bad keys and unauthenticated calls
Error: invalid storage key
    at assertSafeKey [90m(/home/user/strout-vault/[39mserver/storage/types.ts:85:30[90m)[39m
    at finishUpload [90m(/home/user/strout-vault/[39mserver/services/upload.ts:59:3[90m)[39m
    at [90m/home/user/strout-vault/[39mserver/routes/uploads.ts:113:27
    at [90m/home/user/strout-vault/[39mserver/routes/util.ts:18:5
    at Layer.handleRequest [90m(/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/lib/layer.js:152:17[90m)[39m
    at next [90m(/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/lib/route.js:157:13[90m)[39m
    at Route.dispatch [90m(/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/lib/route.js:117:3[90m)[39m
    at handle [90m(/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/index.js:435:11[90m)[39m
    at Layer.handleRequest [90m(/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/lib/layer.js:152:17[90m)[39m
    at [90m/home/user/strout-vault/[39mnode_modules/[4mrouter[24m/index.js:295:15

 ✓ tests/api/upload.test.ts (6 tests) 1154ms
stdout | tests/api/search.test.ts
[mcp] warning: MCP_READER_DATABASE_URL / MCP_PROPOSER_DATABASE_URL not set; tools use the app's own database role (fine for development, refused in production)
[mcp] OAuth disabled: Issuer URL must be HTTPS (PUBLIC_URL must be https, or localhost for development). Personal access tokens still work.

 ✓ tests/api/search.test.ts (8 tests) 1182ms
 ✓ tests/unit/messages.test.ts (18 tests) 288ms
 ✓ tests/unit/embeddings.test.ts (8 tests) 66ms
 ✓ tests/unit/chunker.test.ts (7 tests) 32ms
 ✓ tests/unit/zoomClient.test.ts (8 tests) 29ms
 ✓ tests/unit/text.test.ts (12 tests) 15ms
 ✓ tests/unit/workspaces.test.ts (5 tests) 13ms
 ✓ tests/unit/mcp-scope.test.ts (7 tests) 13ms
 ✓ tests/unit/clips.test.ts (8 tests) 16ms
 ✓ tests/unit/extract.test.ts (5 tests) 12ms
 ✓ tests/unit/videoSource.test.ts (13 tests) 8ms
 ✓ tests/unit/vtt.test.ts (4 tests) 11ms
 ✓ tests/unit/session.test.ts (3 tests) 7ms
 ✓ tests/unit/twilio.test.ts (4 tests) 6ms
 ✓ tests/unit/groq.test.ts (4 tests) 6ms

 Test Files  27 passed (27)
      Tests  261 passed (261)
   Start at  13:11:33
   Duration  108.59s (transform 2.35s, setup 0ms, collect 22.17s, tests 77.28s, environment 9ms, prepare 2.78s)
```
