# Every ingest point, and how to turn each one on

One checklist for everything that brings a conversation into the vault. Each ingest point lands as `interactions`
rows, goes through the same transcription → embedding → search/MCP path, is redacted (card numbers, SSNs, bank
numbers) and is never filed under **phalanx** automatically: unclear items go to **inbox**, with a review item when the
rules suggest a better home.

**Verify, don't trust:** <https://strout-vault.replit.app/pipeline> → **Sources** shows every ingest point below with its
status (live / configured but never run / not configured / erroring), last success, items in the last 24 h and 7 d,
total and last error, read from what each one actually wrote. A collector silent for an hour gets a warning.

## What each one captures

| Ingest point | Captures | Lands as (`kind` / `source`) | Runs | State on 2026-10-27 |
|---|---|---|---|---|
| Zoom | cloud recordings + Zoom's transcript | `meeting` / `zoom` | hourly worker | live |
| Gmail (3 accounts) | email threads, plain text, filtered | `email_thread` / `gmail` | 10-minute Repl + hourly worker | connected, never synced → steps B, C |
| iMessage / SMS | texts, one thread per conversation per day | `text_thread` / `imessage` | Mac collector, every 15 min | merged, not installed → step D |
| iPhone call recordings | Notes with audio titled "Call with …" / "Call Recording" (any folder): audio + Apple's transcript (kept for comparison) | `call` / `iphone_call` | Mac media collector, every 10 min; Shortcut | **new** → steps A, E, F |
| Voice Memos | recordings (≥ 5 s) | `recording` / `voice_memo` | Mac media collector; Shortcut | **new** → steps A, E, F |
| Apple Notes | text notes (≥ 40 characters, not `Private`, not locked) | `note` / `apple_note` | Mac media collector | **new** → steps A, E |
| Google Meet | recordings + the transcript Doc, participants from transcript and calendar | `meeting` / `meet` | hourly worker (`meet` step) | **new** → steps A, G |
| Contractor calls | Twilio tracked numbers, recorded and forwarded | `call` / `contractor_call` | webhooks | code live, 0 numbers → step H |
| TikTok DMs | DMs to @hemakesbigmoves, one thread per conversation per day, people matched by handle | `text_thread` / `tiktok` | Mac collector (browser), every 30 min | **new** → step I |
| Instagram DMs | DMs to a Business/Creator account, via the official API | `text_thread` / `instagram` | 10-minute Repl + hourly worker (`instagram` step) | **new** → step I |

## Turn it on, in order

### A. Apply migration 0010 (you do this; the app never runs DDL)

1. Open the Neon SQL editor for **relationship-engine**:
   <https://console.neon.tech/app/projects/dry-snow-01633657/sql-editor> (branch `main`, as the owner role).
2. Paste the whole of [`db/migrations/0010_device_and_meet.sql`](../db/migrations/0010_device_and_meet.sql) and run it.
   Additive and idempotent. It widens `interactions.kind` (`recording`, `note`), adds `api_tokens.purpose`, the Meet
   provider and `capability`/`detail` on `message_accounts`, and a unique index on device-uploaded `media.sha256`.
3. Check <https://strout-vault.replit.app/api/health>: `schema.version` starts with `v0.10`.
4. Deploy the web Repl and the worker Repl (pull `main`, **Publish** in each).

### B. Gmail: the 10-minute sync Repl (pending from docs/MESSAGES.md step 5)

1. <https://replit.com/import/github> → import `bosdesigner/strout-vault`, name it `strout-vault-messages`.
2. Secrets: the worker Repl's (its Secrets tab → **Edit as .env** → copy all) plus `WORKER_MODE=1` and
   `WORKER_STEPS=gmail,embed`.
3. **Publish → Scheduled**, cron `*/10 * * * *`, timeout 9 minutes. Run it once from the deployment page.
4. In the Shell: `git update-index --skip-worktree .replit` (README step 6.5).
5. Sources: each Gmail row turns **live** within 10 minutes.

### C. Gmail: backfill each account (pending from docs/MESSAGES.md step 6), from the worker Repl's Shell

```bash
npm run messages:gmail -- --account <address> --since 30 --dry-run   # counts only
npm run messages:gmail -- --account <address> --since 30
npm run messages:gmail -- --account <address> --since 365
```

Repeat for all three addresses. Resumable; re-running skips what is already in.

### D. iMessage collector on the Mac (pending from docs/MESSAGES.md step 7)

Follow [`collectors/imessage/README.md`](../collectors/imessage/README.md): Node ≥ 22.13, Full Disk Access for the
node binary, a token of kind **iMessage collector** from <https://strout-vault.replit.app/agents>, `--dry-run
--from-start`, then the launchd plist. Sources: **iMessage / SMS** turns live after its first batch.

### E. Mac media collector (voice memos, call recordings, notes)

Full steps: [`collectors/apple-media/README.md`](../collectors/apple-media/README.md). In short:

1. On the iPhone: Settings → [your name] → iCloud → **Notes** on, **Voice Memos** on (so the Mac has the copies).
2. Full Disk Access for the node binary (the same one as the iMessage collector covers both):
   <x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles> (paste into Safari or `open` it).
3. Token: <https://strout-vault.replit.app/agents> → **New token**, Kind **Mac media collector**, then
   `security add-generic-password -U -s strout-vault -a apple-media -w "$(pbpaste)"` (Keychain, never a file).
4. `node collector.mjs --discover` → paste the output into
   [`docs/ingest-verification/discover.md`](ingest-verification/discover.md). Stop if any line says `SCHEMA MISMATCH`.
5. Optional filters: `~/.strout-vault/apple-media.json` (copy `apple-media.example.json`).
6. `STROUT_VAULT_URL=https://strout-vault.replit.app node collector.mjs --backfill --dry-run`, then
   `node collector.mjs --backfill` (add `--since YYYY-MM-DD` to limit it).
7. Load the launchd plist `com.stroutvault.apple-media.plist` (every 10 minutes). Sources: the three **Mac media
   collector** rows go live; if the Mac sleeps for over an hour they show a warning.

### F. iPhone Shortcut (for when the Mac is off)

1. Token: <https://strout-vault.replit.app/agents> → **New token**, Kind **iPhone Shortcut**.
2. Build **Send to Vault** following [`collectors/ios/SHORTCUT.md`](../collectors/ios/SHORTCUT.md); test the endpoint
   with its `curl` block first.
3. Share a call recording from Notes: it says **Saved**; share it again: **Already in vault**. Sources: **iPhone
   Shortcut** goes live after the first send.

### G. Google Meet (per account; the three Gmail addresses may not all record Meet)

1. Enable the Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com> (and, for participants
   from the calendar, the Calendar API: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>).
2. Add the scopes on the consent screen's Data Access page: <https://console.cloud.google.com/auth/scopes> →
   **Add or remove scopes** → `.../auth/drive.meet.readonly` (and `.../auth/calendar.events.readonly` if wanted).
   While the app is in testing mode, every address must be a test user: <https://console.cloud.google.com/auth/audience>.
3. Add the redirect URI to the existing OAuth client: <https://console.cloud.google.com/apis/credentials> → the Strout
   Vault web client → **Authorized redirect URIs** → `https://strout-vault.replit.app/api/messages/meet/callback`.
4. Signed in to the vault, open once per account:
   <https://strout-vault.replit.app/api/messages/meet/connect?calendar=1> (drop `?calendar=1` for Drive only). If it
   answers that it could not read which account it is, use
   <https://strout-vault.replit.app/api/messages/meet/connect?calendar=1&identify=1>.
5. Backfill from the worker Repl's Shell: `npm run messages:meet -- --account <address> --since 90 --dry-run`, then
   without `--dry-run`. New recordings arrive with the hourly worker (`meet` is in its default steps).
6. Sources: one **Google Meet** row per account; an account whose plan never recorded shows "no Meet recordings on
   this account" and is checked again, cheaply, each hour.

### H. Contractor calls (unchanged; shown here for completeness)

Buy a number in Twilio (<https://console.twilio.com/us1/develop/phone-numbers/manage/search>), point its voice webhook
at `https://strout-vault.replit.app/webhooks/twilio/voice`, set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` on the web
Repl, and record the number at <https://strout-vault.replit.app/access>. Sources: **Contractor calls** goes from "not
configured" to "configured, never run", then live after the first recorded call.

### I. TikTok and Instagram DMs

Apply [`db/migrations/0011_social_dms.sql`](../db/migrations/0011_social_dms.sql) like step A, change the messages Repl's
`WORKER_STEPS` to `gmail,instagram,embed`, then follow [`docs/SOCIAL_DMS.md`](SOCIAL_DMS.md): the TikTok collector on
the Mac ([`collectors/tiktok/README.md`](../collectors/tiktok/README.md)) and the Instagram connect link. Sources:
**TikTok DMs** and **Instagram DMs @<account>** rows.

## Notes

- **Extraction** (facts and commitments) is a separate build. Today the worker's extract step skips `text_thread`,
  `email_thread` and every `note` (notes have no transcript row); voice memos, iPhone calls and Meet recordings are
  transcribed and therefore read by extraction once they are filed in a workspace listed in `EXTRACT_WORKSPACES`
  (`inbox` items are unfiled and `personal`/`phalanx` need naming).
- Routing rules for notes by folder live in [`config/message_routing.yml`](../config/message_routing.yml)
  (`apple_notes_folders`). Calls route by who was on them, like texts.
- Google keeps an app in **testing** mode to 7-day refresh tokens; publish the consent screen (internal use is fine)
  or reconnect weekly. This applies to Gmail as much as to Meet.
- Nothing here deletes anything: not on the phone, not in Drive, not in the vault.
