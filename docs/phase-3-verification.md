# Phase 3 verification

Evidence for the Phase 3 pull request: contractor logins scoped to one
workspace (email magic links), and tracked phone numbers (Twilio) whose
recordings land in the vault. Everything ran against a local PostgreSQL 16 and
the `local` storage driver; nothing touched Neon, B2, R2, Resend or Twilio.
No phone numbers were bought and no email was sent: the mailer and the Twilio
recording fetch are swapped for in-memory fakes under test.

## 1. Unit and API tests (`npm test`)

96 tests across 10 files, all passing: the 80 from Phases 1–2 plus
`tests/unit/twilio.test.ts` (4) and `tests/api/phase3.test.ts` (12).

```
 ✓ tests/unit/twilio.test.ts (4 tests)
   twilio signature › matches Twilio's published example        (token 12345, docs URL → 0/KCTR6DLpKmkAf8muzZqo1nDgQ=)
   twilio signature › accepts a valid signature and rejects tampering
   phone normalisation › turns US formats into E.164 and leaves E.164 alone
   phone normalisation › escapes XML for TwiML
 ✓ tests/api/phase3.test.ts (12 tests)
   contractor login with magic links › sends a single-use link to a known membership and says the same thing for unknown addresses
   contractor login with magic links › activates an invited membership on first login and refuses disabled ones
   contractor login with magic links › rate-limits link requests
   what a contractor can see › library, status and search are limited to recordings they took part in or uploaded, in their workspace
   what a contractor can see › cannot reach owner-only sections or change data
   what a contractor can see › can upload, and the upload lands in their workspace tagged with them so they can see it
   owner: memberships and tracked numbers › lists, invites (sending a link), updates and re-sends
   owner: memberships and tracked numbers › records an already-bought Twilio number and lists calls
   twilio webhooks › refuses requests without a valid signature and when Twilio is not configured
   twilio webhooks › answers an incoming call with the notice and a recorded forward, and records the call
   twilio webhooks › copies the finished recording into the vault as a contractor_call interaction with media, jobs and participants
   twilio webhooks › records a failed fetch on the call and returns 500 so Twilio retries

 Test Files  10 passed (10)
      Tests  96 passed (96)
```

What the important ones prove:

- **Magic links** — only a SHA-256 hash of the token is stored; the link works once (second use → `/login?error=link`); unknown and known addresses get the identical response; a disabled membership gets no link; an invited one becomes `active` with `last_login_at` on first use.
- **Scoping** — for Kevin (contractor, Another Story) the library is exactly the set `workspace_id = 'another_story' AND (participant OR media.uploaded_by)` computed directly in SQL; hidden recordings are 404 on detail, segments, speakers and dropped from status polling; search groups are a subset of the visible set; `/api/review`, `/api/projects`, `/api/memberships`, `/api/tracked-numbers`, `/api/calls`, person detail and every mutation (title, tags, participants, clips, people) are 403; the people list is limited to their workspace with contact details stripped; their upload is forced into their workspace, `media.uploaded_by` is them and they are a participant.
- **Twilio** — the signature check matches Twilio's own worked example and rejects tampered bodies, wrong tokens, wrong URLs and missing headers; an incoming call to a tracked number answers with the recording notice, `<Dial record="record-from-answer-dual">`, the recording callback URL and the forward-to number, and writes a `calls` row with the caller matched to Tom Ashworth by phone; the recording callback fetches `<RecordingUrl>.mp3` with basic auth once, stores it under `calls/<yyyy>/<mm>/<CallSid>.mp3` byte-for-byte, and creates the `interactions` row (`contractor_call`, `queued`, "Call with Tom Ashworth", 318 s), the `media` row, two pending jobs and both participants; the contractor can then open it; a repeated callback is a no-op; a 404 from Twilio marks the call `failed` and returns 500.

## 2. End-to-end tests (`npm run test:e2e`)

31 passing (27 from Phases 1–2 plus `tests/e2e/phase3.spec.ts` on Desktop Chrome and the iPhone 13 viewport):

- **owner: access page** — the seeded contractor login and tracked number show; inviting a contractor creates an `invited` row and the in-memory mailer holds a link for that address; recording a Twilio number normalises both phone numbers to E.164 and shows the contractor.
- **contractor** — from a logged-out browser: pick "Email me a link", enter Kevin's address, see "Check your email", open the link from the test mailbox, land on the library with the "Recordings you were part of or uploaded in Another Story" banner, no People/Projects/Review navigation and no workspace switcher; every card is one they are on or uploaded, in their workspace; `/api/review` is 403; a recording they are on opens without the tagging form; search only returns their recordings; after clearing cookies the same link is refused with the "expired or already used" message.

## 3. Screenshots

[`docs/screenshots/phase-3/`](screenshots/phase-3/), 1440 px and 390 px, produced by
`SCREENSHOT_PHASE=phase-3 npm run screenshots` against a dev server started with
`EXPOSE_TEST_MAIL=1` (no overflow on either width):

| page | 1440 | 390 |
|---|---|---|
| Sign in, "Email me a link" | [login-link-1440](screenshots/phase-3/login-link-1440.png) | [login-link-390](screenshots/phase-3/login-link-390.png) |
| Link sent | [login-link-sent-1440](screenshots/phase-3/login-link-sent-1440.png) | [login-link-sent-390](screenshots/phase-3/login-link-sent-390.png) |
| Access & numbers (owner) | [access-1440](screenshots/phase-3/access-1440.png) | [access-390](screenshots/phase-3/access-390.png) |
| Library as a contractor (via a real magic link) | [contractor-library-1440](screenshots/phase-3/contractor-library-1440.png) | [contractor-library-390](screenshots/phase-3/contractor-library-390.png) |
| Recording as a contractor | [contractor-recording-1440](screenshots/phase-3/contractor-recording-1440.png) | [contractor-recording-390](screenshots/phase-3/contractor-recording-390.png) |

## 4. Migration

`db/migrations/0003_access_and_calls.sql` was applied twice in a row to the
local database to confirm it is idempotent (second run: only "already exists,
skipping" notices), and `/healthz` then reports `schema.version` =
`v0.3 access and calls: memberships, login_tokens, tracked_numbers, calls`.
`npm run db:local` applies it automatically after 0001 and 0002.
