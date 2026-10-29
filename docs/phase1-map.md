# Phase 1 map: what the code actually does (2026-10-29)

Read before changing anything for the Phase 1 build (commitment extraction, Zoom filing and linking,
the Apple Notes check). Production numbers are from the relationship-engine Neon project
(`dry-snow-01633657`, branch `main`), read-only, on 2026-10-29.

## 1. Ingest pipeline stages and `pipeline_status`

One web process (`server/index.ts`) takes pushes; one worker (`server/worker/run.ts`, hourly
Scheduled Deployment, plus a 10-minute `gmail,embed` deployment) pulls. Worker steps run in this
order: `zoom, meet, leads, gmail, refile, transcribe, embed, extract, scout, cut, report`.

| Source (`interactions.source`) | Kind | Entry point | Initial `pipeline_status` | Who moves it to `ready` |
|---|---|---|---|---|
| `zoom` | meeting | worker `zoom` step: `server/worker/sync.ts` `recordRecording` (enumerate) → `afterVerified` (download) | `queued` at insert | `server/worker/transcribe.ts:308` after the Zoom VTT / captions / Groq transcript is stored |
| `meet` | meeting | worker `meet` step: `server/meet/sync.ts` `recordMeeting` | `queued` | same transcribe step (Meet's own transcript) |
| `upload` | other | web `POST /api/uploads/*` → `services/upload.ts` `finishUpload` | `queued` | transcribe |
| `contractor_call` | call | Twilio webhooks → `services/calls.ts` | `queued` | transcribe |
| `iphone_call`, `voice_memo` | call, recording | Mac collector `collectors/apple-media` → `POST /api/ingest/device/{presign,finalize}` → `server/device/ingest.ts` → `finishUpload` | `queued` | transcribe |
| `apple_note` | note | same collector → `POST /api/ingest/device/note` → `device/ingest.ts` `upsertNote` | written `ready` directly (text only, one segment per paragraph) | n/a |
| `imessage` | text_thread | Mac collector `collectors/imessage` → `POST /api/ingest/messages` → `server/messages/ingest.ts` | written `ready` directly | n/a |
| `gmail` | email_thread | worker `gmail` step → `messages/gmail/sync.ts` → `messages/ingest.ts` | written `ready` directly | n/a |

`failed` is set by `transcribe.ts:327` (`markInteraction`); the Pipeline page's retry sets it back
to `queued` (`routes/pipeline.ts:115`). `null` reads as `ready` everywhere.

After `ready`, `embed` (sets `embedded_at`, never touches `pipeline_status`), `extract` and `scout`
read the row. **`ready` means "transcript exists", nothing more.** Extraction, embedding and
scouting each keep their own bookkeeping columns (`extracted_at`, `embedded_at`, `scouted_at`).

## 2. `facts` and everything that writes it

`facts` (0001): `kind` check `commitment | decision | price | followup | issue | preference | other`,
`status` default `open`, `owner_party_id`, `about_party_id`, `project_id`, `amount`, `due_date`,
`confidence`, `quote_start_sec`, plus `source_review_id` (0007). No quote column, no close
timestamp, no link to a second source.

Writers, all of them:

1. `server/services/review.ts` `APPLIERS.new_fact`: approving a `new_fact` review item on the
   Review page inserts the fact. **This is the only code path that inserts facts.**
2. Nothing else. The extractor (`server/worker/extract.ts`) inserts `review_queue` rows of type
   `new_fact`, never facts. The MCP `propose_update` tool does the same.

Readers: MCP `list_open_commitments` (`server/mcp/tools/commitments.ts`, kinds `commitment, task,
follow_up, followup`, `coalesce(status,'open') = 'open'`, scoped on `coalesce(f.workspace_id,
i.workspace_id)`), `list_leads` (open commitments per lead), the recording page Facts tab, person
and project pages (`components/FactList.tsx`).

Extraction (`server/worker/extract.ts`, docs/EXTRACTION.md) as written:

- runs only when `ANTHROPIC_API_KEY` **and** `EXTRACT_MONTHLY_BUDGET_USD > 0`;
- reads only interactions with a workspace in `EXTRACT_WORKSPACES` (`*` = everything except
  phalanx, personal and inbox), with a transcript row **and** segments, and skips `text_thread` /
  `email_thread` outright ("wait for their own extraction pass");
- queues `new_fact` / `link_party_interaction` / `link_project_interaction` into `review_queue`.

Production state: `facts` = 0 rows, `interactions.extracted_at` set on 0 rows, no
`anthropic-extract` row in `spend_ledger`, no `new_fact` item in `review_queue` ever. The step has
never sent a request: the worker logs `extract: N recording(s) waiting; extraction is off until
EXTRACT_MONTHLY_BUDGET_USD is set`.

## 3. Parties: creation and matching

Created by:

- `server/leads/sync.ts` (worker `leads` step): match by email (case-insensitive), then phone
  (last ten digits), else create; adds a `prospect` role in `another_story`. A lead without a
  name gets its email as the party name (`tanner@designyourprice.com`). 504 parties, 776 lead records.
- `services/review.ts` appliers `new_party` (from message ingest's unknown-sender review items and
  MCP proposals). 263 `new_party` items are open.
- People/Projects pages (hand edits).

Matched by:

- `messages/ingest.ts` `matchParties`: exact email (lowercased) and phone (digit keys). No names.
- `device/ingest.ts` `matchNames`: exact lowercase full name, only when exactly one person has it.
  Used by iPhone calls / voice memos (contact names from the phone) and Meet.
- `workspaces/propose.ts` `knownPeople`: names of people with roles in exactly one workspace, for
  the workspace proposer only.
- `leads/sync.ts`: lead names in recording titles → `link_party_interaction` review items.

Nothing does fuzzy matching. Ben Strout is not a party; "owner" is recognised by identifiers
(`OWNER_EMAILS`, `OWNER_PHONES`, connected Gmail accounts) and `OWNER_NAME` (`messages/identity.ts`).

Zoom never resolves participants at all: `recordRecording` stores the recording payload (no
participant list: `recording:read:admin` returns only host and files) and nothing else. Groq
transcripts carry no speaker labels (1,159 of 1,191 meeting transcripts), so speaker matching has
nothing to work with on most meetings.

## 4. `workspace_id` assignment

| Source | How |
|---|---|
| Zoom | **never at ingest.** Only by approving an `interaction_workspace` review item, produced by `npm run workspaces:propose` (`server/workspaces/propose.ts` + `classify.ts` + `rules.ts`), run by hand. 242 approved, 72 rejected. |
| Meet, iPhone calls, voice memos, notes, iMessage, Gmail | `messages/ingest.ts` `routeThread` at ingest: every matched party votes its workspaces (routing rules, roles, affiliations, projects), email domains as fallback; exactly one winner files it, otherwise `inbox` (+ a `workspace_assignment` review item when there is a suggestion). phalanx never automatically. |
| Inbox items | worker `refile` step (`workspaces/refile.ts`) re-routes `inbox` items whenever their people become known. |
| Uploads | the uploader's choice, else null. |

Production: 872 Zoom meetings with `workspace_id` null (155 of them titled "…AnotherStory
Assessment" or "Another Story's Zoom Meeting", 15 feasibility/discovery/onboarding), 815 of those
with no participants; 194 of the 248 filed `another_story` Zoom meetings also have no participants.

## 5. Apple Notes and iPhone calls (item 3)

Both come from one Mac collector, `collectors/apple-media` (LaunchAgent every 10 minutes):
call recordings are read from Apple Notes' call-recording attachments and sent as
`source = iphone_call`, plain notes as `source = apple_note`, kind `note`.

Production `import_runs` (source `apple_media`): a run every 10 minutes, the last at 2026-10-29
01:45 UTC, all `ok`. The latest run scanned 1,600 notes, 136 voice memos and 74 call recordings,
and had nothing new to send. Stored: **1,600 `note` interactions** (newest note 2026-10-28) and
**73 `iphone_call` interactions, the newest 2026-10-28 19:14 UTC**. 57 of the calls, every note,
and most texts and email sit in workspace **`inbox`**, which a `*` token scope never includes
(`server/mcp/scope.ts` `RESTRICTED_WORKSPACES`). The MCP client only sees the 16 calls that were
filed (newest 2026-10-21) and no notes. The ingester works; the symptom is a scope and filing gap.

## 6. Where things plug in

- Worker steps: `server/worker/run.ts` (`ALL_STEPS`, the `for (const step of steps)` loop).
- Push ingest routes: `server/routes/ingest.ts` (device, messages), `server/routes/twilioWebhooks.ts`.
- Config files the app reads: `config/message_routing.yml`, `config/message_blocklist.yml`
  (`messages/rules.ts`). Workspace classifier rules are code (`workspaces/rules.ts`).
- Migrations are applied by hand (`db/migrations/*.sql`, latest `0010`); the app never runs DDL.
