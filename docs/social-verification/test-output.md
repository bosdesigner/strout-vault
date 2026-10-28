# Test output (2026-10-27)

Local Postgres 16 + pgvector, `npx vitest run` from the repo root. Full suite, then the two new files verbose.

```
 ✓ tests/api/mcp.test.ts (30 tests) 10540ms
 ✓ tests/api/messages.test.ts (18 tests) 7148ms
 ✓ tests/api/social.test.ts (12 tests) 2202ms
 ✓ tests/api/worker.test.ts (9 tests) 12323ms
 ✓ tests/api/ingest-e2e.test.ts (9 tests) 8480ms
 ✓ tests/api/phase3.test.ts (12 tests) 1344ms
 ✓ tests/api/device.test.ts (15 tests) 2966ms
 ✓ tests/api/phase5.test.ts (8 tests) 17572ms
 ✓ tests/api/leads.test.ts (8 tests) 923ms
 ✓ tests/api/extract.test.ts (13 tests) 877ms
 ✓ tests/api/phase2.test.ts (15 tests) 1260ms
 ✓ tests/api/workspaces.test.ts (6 tests) 3463ms
 ✓ tests/unit/messages.test.ts (18 tests) 160ms
 ✓ tests/unit/social.test.ts (28 tests) 76ms
 ✓ tests/unit/apple-media.test.ts (12 tests) 5929ms
 ✓ tests/api/upload.test.ts (6 tests) 1077ms
 ✓ tests/api/library.test.ts (13 tests) 1051ms
 ✓ tests/unit/embeddings.test.ts (8 tests) 66ms
 ✓ tests/unit/clips.test.ts (8 tests) 9ms
 ✓ tests/unit/extract.test.ts (5 tests) 10ms
 ✓ tests/unit/zoomClient.test.ts (8 tests) 22ms
 ✓ tests/api/search.test.ts (8 tests) 944ms
 ✓ tests/api/sources.test.ts (5 tests) 1631ms
 ✓ tests/api/auth.test.ts (10 tests) 4361ms
 ✓ tests/unit/chunker.test.ts (7 tests) 26ms
 ✓ tests/unit/mcp-scope.test.ts (7 tests) 13ms
 ✓ tests/unit/workspaces.test.ts (5 tests) 10ms
 ✓ tests/unit/text.test.ts (12 tests) 11ms
 ✓ tests/unit/videoSource.test.ts (13 tests) 7ms
 ✓ tests/unit/google-ratelimit.test.ts (4 tests) 13ms
 ✓ tests/unit/twilio.test.ts (4 tests) 6ms
 ✓ tests/unit/groq.test.ts (4 tests) 6ms
 ✓ tests/unit/vtt.test.ts (4 tests) 7ms
 ✓ tests/unit/session.test.ts (3 tests) 9ms
 Test Files  34 passed (34)
      Tests  347 passed (347)

 ✓ tests/api/social.test.ts > POST /api/ingest/social > takes only an ingest:messages token and a well-formed batch 25ms
 ✓ tests/api/social.test.ts > POST /api/ingest/social > turns a TikTok batch into one thread per conversation per day, matched by handle 63ms
 ✓ tests/api/social.test.ts > POST /api/ingest/social > is idempotent, merges a later batch into the day, and never stores Ben's own handle or a blocklisted one 31ms
 ✓ tests/api/social.test.ts > POST /api/ingest/social > a handle added to someone already in the vault links their DMs, closes the review item and files the thread 40ms
 ✓ tests/api/social.test.ts > POST /api/ingest/social > approving an unknown account creates the person with the handle 38ms
 ✓ tests/api/social.test.ts > POST /api/ingest/social > dm_sources files unknown senders under a workspace, and never under phalanx 39ms
 ✓ tests/api/social.test.ts > MCP on DMs > search finds TikTok DMs for an Another Story token and nothing for another workspace; get_party resolves a handle 256ms
 ✓ tests/api/social.test.ts > Instagram > connects through Instagram Login and stores only an encrypted 60-day token 37ms
 ✓ tests/api/social.test.ts > Instagram > reads changed conversations, inline or message by message, as DM threads 52ms
 ✓ tests/api/social.test.ts > Instagram > the next pass reads only conversations updated since, and refreshes a token close to expiry 24ms
 ✓ tests/api/social.test.ts > Instagram > a revoked token marks the account erroring, and the Sources panel shows TikTok and Instagram 25ms
 ✓ tests/api/social.test.ts > Instagram > no table and no log line holds a redacted secret 83ms
 ✓ tests/unit/social.test.ts > handles > normalise to <platform>:<username> and stay apart from phones and emails 8ms
 ✓ tests/unit/social.test.ts > handles > Ben's own handles come from OWNER_HANDLES and connected accounts 1ms
 ✓ tests/unit/social.test.ts > handles > config: dm_sources must name tiktok or instagram; blocklisted handles are normalised 2ms
 ✓ tests/unit/social.test.ts > handles > a DM that is only a code is dropped; a longer one keeps its words 1ms
 ✓ tests/unit/social.test.ts > social batches > group per conversation per Chicago day, with prefixed message ids 5ms
 ✓ tests/unit/social.test.ts > Instagram API shapes > reads both time formats 1ms
 ✓ tests/unit/social.test.ts > Instagram API shapes > finds the other person, Ben's side, shares and unsupported messages 1ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 3:05 PM 1ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 15:05 1ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Today 8:00 AM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Yesterday 11:59 PM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Monday 9:15 AM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Tue 9:15 AM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 10/26/2026 10:00 AM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 2026-10-01 07:30 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Oct 2, 2026 1:00 PM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > Dec 30 1:00 PM 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 2h 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > 5 minutes ago 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: time labels > is null for text that is not a time 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: what is new > first read takes everything; later reads take only what follows the last messages seen 2ms
 ✓ tests/unit/social.test.ts > TikTok collector: what is new > a repeated short message is still new when it follows what was seen 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: what is new > when nothing lines up, only never-seen messages count 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: what is new > list rows are reopened only when their preview changes or they are unread 0ms
 ✓ tests/unit/social.test.ts > TikTok collector: what is new > state is written privately and read back 2ms
 ✓ tests/unit/social.test.ts > TikTok collector: in-page readers > reads the conversation list without opening anything 23ms
 ✓ tests/unit/social.test.ts > TikTok collector: in-page readers > reads the open conversation: who, whose side, time labels, shared videos 25ms
 ✓ tests/unit/social.test.ts > TikTok collector: in-page readers > the probe reports structure and counts, never text 11ms
 Test Files  2 passed (2)
      Tests  40 passed (40)
```
