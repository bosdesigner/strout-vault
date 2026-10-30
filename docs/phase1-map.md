# Phase 1 (v2) map: where things are decided today

Written before any Phase 1 change, from the code on `main` (`80e5c84`) and read-only queries against
production (Neon `relationship-engine`, branch `main`, 2026-10-29). Everything in
[phase1-verification.md](phase1-verification.md) builds on what is written here.

## 1. Where `workspace_id` is assigned, per source

| Source | Code | How the workspace is chosen | What happens when nothing matches |
|---|---|---|---|
| Zoom (`kind=meeting`, `source=zoom`) | `server/worker/sync.ts` `recordRecording()` | **Never set.** The insert has no `workspace_id` column. | `null`. The only route out is `npm run workspaces:propose` / the extract step's `unfiledJobs()`, which use `server/workspaces/classify.ts` (title regexes, people named in the title, transcript keyword counts) and **queue an `interaction_workspace` review item**. Nothing is filed until Ben approves it on Review. |
| Google Meet (`meeting`, `meet`) | `server/meet/sync.ts` `recordMeeting()` | `routeThread()` over the parties matched from the transcript's speakers and the calendar event's attendees, then `noAutoPhalanx()` | `inbox` plus a `workspace_assignment` review item |
| iMessage / SMS (`text_thread`) | `server/messages/ingest.ts` `ingestThreads()` → `routeThread()` | Each participant matched **exactly** by phone/email to a party contributes its rule from `config/message_routing.yml`, else every workspace it has a role in (directly, through a current org affiliation, or on a project). Exactly one workspace wins. | `inbox` plus a `workspace_assignment` review item, also when 2+ workspaces match and always for phalanx |
| Gmail (`email_thread`) | same as iMessage; `server/messages/gmail/sync.ts` | Same participant routing, then email **domain** rules. **The account the thread came from (`source_payload.account`) is not used.** | `inbox` + review |
| iPhone call recordings (`call`, `iphone_call`) and Voice Memos (`recording`, `voice_memo`) | `server/device/ingest.ts` `finalizeDevice()` | `routeThread()` over the participants the collector sent (a name parsed from "Call with X", or a phone number), `noAutoPhalanx()` | `inbox` + review. A voice memo has no participants at all, so it **always** lands in `inbox`. |
| Apple Notes (`note`, `apple_note`) | `server/device/ingest.ts` `upsertNote()` | Only the folder → workspace map `apple_notes_folders` in `config/message_routing.yml` | `inbox`, **no review item**. The map ships commented out and every production note is in folder "Notes", so all 1,601 notes are in `inbox`. |
| Browser upload (`other`, `upload`) | `server/services/upload.ts` | Whatever the uploader picked (or the contractor's own workspace) | `null` when the owner picks none (7 rows) |
| Twilio tracked numbers (`call`) | `server/services/calls.ts` | The tracked number's workspace | — |
| Inbox refile | `server/workspaces/refile.ts`, worker step `refile` and after people edits | Re-runs `routeThread()` over `inbox` items using their **matched** parties | Leaves them in `inbox` |

### Why nearly everything lands in `inbox` (or `null`)

1. **Routing only knows people who are already parties with a role, and only by exact phone/email.**
   In production the 477 inbox text threads, 211 inbox email threads, 136 voice memos and 59 inbox calls
   have **0 rows in `interaction_participants` between them** (one email thread has one). The senders are
   phone numbers and addresses no party carries: 277 `new_party` review items for them are still open.
   With no matched party, `routeThread()` returns "No participant maps to a workspace".
2. **Content is never read.** No routing path looks at the text, so a thread about an AnotherStory
   lead from an unknown number cannot be filed.
3. **The Gmail account is ignored.** A thread in `ben@anotherstory.com`'s mailbox from
   `logan@anotherstory.com` lands in `inbox` because Logan is not a party with a role.
4. **Notes route on folder only**, and the folder map is empty.
5. **Zoom is never routed at ingest** (the 871 `null` meetings). The classifier that exists only proposes:
   60 `interaction_workspace` items are open, 72 were rejected. Most titles say nothing on their own
   ("Ben Strout's Zoom Meeting" ×126, "Another Story's Zoom Meeting" ×59, "Ben and Nea" ×10).
6. **Review is the only exit, and it is too big to keep up with.** On 2026-10-27, 623
   `workspace_assignment` items whose suggested workspace was `null` were rejected in bulk, because
   there was nothing to approve.
7. **phalanx is never assigned automatically** (`noAutoPhalanx`, `NEVER_AUTO_ASSIGNED`), so anything
   that maps to phalanx also waits in `inbox`.

**The connector cannot see any of it.** Ben's Claude connector grant has `workspace_scope =
["another_story","strout_arch","southern_shutter","sepp","credvault","unassigned"]` (oauth_tokens
#111/#112). `inbox` is restricted, so the 2,484 inbox rows are invisible. `unassigned` covers the 878 null rows.

## 2. The `jobs` table and who consumes each stage

`jobs (media_id, stage in transcribe|extract|index|clip, status, attempts, error)`, unique on `(media_id, stage)`.
The table comes from the relationship-engine v0.1 design, when the meeting-vault Python service was its consumer.

| Stage | Written by | Read by | Reality |
|---|---|---|---|
| `transcribe` | `sync.ts afterVerified()` (Zoom), `meet/sync.ts`, `services/upload.ts finishUpload()` (uploads + device files), `services/calls.ts` (Twilio) | `worker/transcribe.ts` reads `max(attempts)` and writes status/attempts as **bookkeeping**. The work itself is picked by `interactions.pipeline_status = 'queued'`. | 221 done, 4 failed |
| `extract` | the same four writers, alongside `transcribe` | **Nothing.** `worker/extract.ts` never touches `jobs`. It picks work by `interactions.extracted_at is null`. | **225 pending, all untouched** (attempts 0, `updated_at` = insert time) |
| `index`, `clip` | nobody | nobody | — |

**Why extract jobs exist only for media items:** a `jobs` row needs a `media_id`. Texts, email and
notes have no media row (they are text-only interactions), so no extract job is ever written for
them. Zoom/Meet/upload/device audio get one beside their transcribe job.

**What actually decides extraction** (`worker/extract.ts processExtraction`, run hourly):
- `recordingJobs()`: filed recordings in `EXTRACT_WORKSPACES` (`*`, which excludes phalanx, personal and inbox),
  `extracted_at is null`, **inner-joined to `transcripts`**. Notes have no `transcripts` row, so they are never read.
- `unfiledJobs()`: null-workspace recordings the regex classifier files at ≥ 0.85.
- `threadJobs()`: text/email threads in a readable workspace with a message in the last 30 days.

Everything in `inbox` and `personal` is excluded, so **0 of the 2,480 inbox items have ever been read**.
And every output goes to `review_queue` (`new_fact`, `link_party_interaction`,
`link_project_interaction`); **a `facts` row is written only when Ben approves**. Production has
**1,560 open `new_fact` proposals and 0 facts**. The worker *is* configured (`extractConfigured: true`,
$100/month); it ran out of candidates (`candidatesRecordings: 0` in the last runs) because of the filters above.

## 3. How parties get onto interactions (`interaction_participants`)

| Path | Matching |
|---|---|
| texts / email (`messages/ingest.ts` → `matchParties()`) | exact normalised email; phone by digit keys (`phoneDigitKeys`). Unknown identifiers → `new_party` review item, no participant row. |
| device calls (`device/ingest.ts identifyParticipants()`) | phone exact; a name only when exactly one party has that name |
| Meet (`meet/sync.ts`) | `matchParties()` on calendar attendee emails, `matchNames()` on transcript speakers |
| Twilio calls | tracked number's party + caller party |
| browser uploads | the people the uploader picked |
| extraction | `link_party_interaction` **proposals** (speaker label → known party), applied on approval (112 approved, 21 open) |
| review `participant_match` | applied on approval |
| **Zoom** | **nothing at ingest.** Zoom participants are not fetched (the S2S app has `recording:read:admin`, `user:read:admin`), the title is not parsed, and recent Zoom transcripts come from Groq without speaker labels (`segments.speaker` is null). Only 111 of 1,192 Zoom meetings have any participant, all of them from approved extraction proposals. |

3,572 of 3,799 interactions have no participant at all. Lead people exist as parties
(`lead_records.party_id`, 481 `another_story` prospect roles), but nothing links an assessment call
titled "Ryan Meagher: AnotherStory Assessment" to party #1243 Ryan Meagher. iPhone calls titled
just "Call Recording" carry no number: iOS writes no contact into that note, and the collector
sends `participants_raw: []`. No two parties share an email today; there are name-level duplicates
such as #7 "Tanner Durfee" and #1196 "tannerdurfee@gmail.com".

## 4. MCP token `workspace_scope`: how it is set and enforced

- **Stored on the token.** Personal access tokens: `api_tokens.workspace_scope`, set on the Agents page
  (`routes/mcpAdmin.ts`). OAuth (the Claude.ai connector): ticked on the consent screen
  (`mcp/auth/consent.ts`), saved on `oauth_clients.workspace_scope` and copied to every
  `oauth_codes` / `oauth_tokens` row. A refresh copies the old token's scope (`oauth.ts`), so
  **changing the client's scope later does not change live tokens**. Those rows need updating too.
- **Defaults on the consent screen:** every workspace is ticked except `RESTRICTED_WORKSPACES =
  phalanx, personal, inbox`, and `unassigned` is unticked. Every restricted box is captioned
  "Investor material", which is wrong for personal and inbox.
- **Resolution:** `mcp/scope.ts resolveScope()`. `"*"` expands to every workspace except the
  restricted three unless they are listed. `unassigned` is a pseudo-id for `workspace_id is null`.
- **Enforcement:** every tool builds its `WHERE` from `scopeSql()` (`tools/filters.ts interactionWhere`,
  `list_open_commitments` uses `coalesce(f.workspace_id, i.workspace_id)`, search adds it to the vector
  query too), and runs as the SELECT-only `mcp_reader` role. Requests for an out-of-scope workspace return an explicit
  "not within this token's scope" note. Every call is written to `mcp_audit`.

## 5. Google Meet `capability: none_found`

`meet/sync.ts enumerateAccount()` lists `mimeType='video/mp4'` files in Drive (`drive.meet.readonly`)
created after `detail.cursor`, or **only the last 14 days** (`FIRST_RUN_DAYS`) when there is no cursor.
The cursor only advances when a recording is found, so an account that has never had one is checked
over a rolling 14-day window, never further back. `capability` becomes `none_found` whenever that
window is empty, and nothing distinguishes "Ben doesn't use Meet" from "Meet meetings happen but
nothing is saved to Drive". The grant has the right scopes (`drive.meet.readonly` +
`calendar.events.readonly`; see `message_accounts` #4).

## 6. Failed transcriptions

Four voice memos (6189, 6193, 6195, 6197) failed 3× with `ffprobe: moov atom not found`: the
m4a in storage is truncated or incomplete (a Voice Memo still recording or still syncing from
iCloud when the collector copied it). #2468 ("Aaron Murphy Another Story initial phone call",
2023) has no media and no pipeline status: a meeting-vault import with nothing to transcribe.
