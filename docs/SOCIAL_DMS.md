# TikTok and Instagram DMs

DMs come into the vault like texts: one `text_thread` interaction per conversation per day (America/Chicago),
matched to people by their **handle**, filed under the workspace those people belong to, and searchable through the
same embedding / search / MCP path. "What did Mike say on TikTok about Huntsville?" works the way it does for texts.

| | TikTok | Instagram |
|---|---|---|
| Read by | a browser collector on Ben's Mac, every 30 min ([`collectors/tiktok`](../collectors/tiktok/README.md)) | the official Instagram API, from the worker every 10 min |
| Why that way | TikTok has no API for an account's own DMs short of its partner-only Business Messaging API | Meta's API covers DMs of a Business or Creator account |
| `source` / `source_ref` | `tiktok` / `tiktok:<account>:<conversation>:<YYYY-MM-DD>` | `instagram` / `instagram:<account>:<conversation id>:<YYYY-MM-DD>` |
| History | whatever the inbox shows (the collector scrolls up on a conversation's first read) | the 20 newest messages of each conversation (an API limit); everything after the account is connected |
| Side effects | opening a conversation marks it read in TikTok (and on the phone) | none: the API does not mark anything read |
| Sends anything? | never | never (the token could; the vault never calls a send endpoint) |

Both go through `server/messages/ingest.ts`, the same path as texts and email: blocklist, one-time codes (a short DM
that is only a code is dropped, a longer one has its digits redacted), card numbers / SSNs / bank numbers redacted,
merge by message id, people matched, threads routed, phalanx never assigned automatically.

## People and handles

A handle is stored on a person as `tiktok:<username>` or `instagram:<username>` (`parties.handles`, migration 0011),
lowercase, no `@`. On a person's page, **Edit** has TikTok and Instagram fields.

- **A DM from a handle on someone's page** is theirs: speaker named, thread filed under their workspace.
- **A DM from an unknown handle** goes to **Review** as "Unknown TikTok account in DMs: …" (once per handle, ever).
  - If they are new: **approve**, and a person is created with the handle.
  - If they are already in the vault (a contractor you know by phone): don't approve. Open their page, add the handle.
    Their DMs are relinked, the review item closes, and Inbox threads they are on are filed (`linkHandles` in
    `server/routes/people.ts`).
- Agents can do the same through `propose_update` (`handles` on `new_party` / `party_edit`) and look people up with
  `get_party {handle: "tiktok:@mikebuilds"}`.

Unknown senders' threads wait in **Inbox**, like texts. Most TikTok DMs come from people the vault does not know yet,
so `config/message_routing.yml` can file them instead:

```yaml
dm_sources:
  tiktok: another_story      # unknown TikTok senders are Another Story leads
  instagram: another_story
```

A known person's own workspace always wins, and phalanx is never taken from here. Junk accounts go in
`config/message_blocklist.yml` under `handles:`.

## Turn it on

### 1. Migration 0011

Neon SQL editor for relationship-engine: <https://console.neon.tech/app/projects/dry-snow-01633657/sql-editor>
(branch `main`). Paste [`db/migrations/0011_social_dms.sql`](../db/migrations/0011_social_dms.sql) and run it. Then
<https://strout-vault.replit.app/api/health> shows `schema.version` starting with `v0.11`. Deploy the web Repl, the
worker Repl and the 10-minute messages Repl (pull `main`, **Publish**).

### 2. Secrets (web, worker and messages Repls)

- `OWNER_HANDLES=tiktok:hemakesbigmoves` (add `instagram:<username>` if you like; a connected Instagram account counts
  as yours anyway).
- On the **messages** Repl: `WORKER_STEPS=gmail,instagram,embed` (was `gmail,embed`).
- For Instagram, after step 4: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`.

### 3. TikTok

Follow [`collectors/tiktok/README.md`](../collectors/tiktok/README.md): token of kind **TikTok DM collector** from
<https://strout-vault.replit.app/agents>, `npm ci`, `--login` once, `--probe`, `--dry-run`, then the launchd plist.
Sources (<https://strout-vault.replit.app/pipeline>) → **TikTok DMs** turns live after the first run.

### 4. Instagram

1. The account must be a **professional** (Business or Creator) account (Instagram app → Settings → Account type and
   tools). In the Instagram app, also turn on **Allow access to messages** (Settings → Messages and story replies →
   Message controls → Connected tools); without it the API returns no conversations.
2. Create a Meta app, type **Business**: <https://developers.facebook.com/apps/creation/>.
3. In the app, add the **Instagram** product and choose **API setup with Instagram login**
   (<https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app>).
   - Under **Set up Instagram business login → Business login settings**, add the redirect URI
     `https://strout-vault.replit.app/api/messages/instagram/callback`.
   - Under **Generate access tokens**, **Add account** and add your Instagram account (that makes it a tester; Standard
     Access is enough for an account you own, no App Review needed).
   - Copy the **Instagram app ID** and **Instagram app secret** from that page into `INSTAGRAM_APP_ID` /
     `INSTAGRAM_APP_SECRET` on all three Repls, and redeploy.
4. Signed in to the vault, open <https://strout-vault.replit.app/api/messages/instagram/connect> and allow. The page
   answers "Connected @<username>". The callback refuses any permission beyond `instagram_business_basic` +
   `instagram_business_manage_messages`, and stores the 60-day token encrypted; the worker refreshes it with 10 days
   left. If it ever expires, Sources says so; open the connect link again.
5. From the worker Repl's Shell, pull what the API still has:
   ```bash
   npm run messages:instagram -- --backfill --dry-run   # counts only, writes nothing
   npm run messages:instagram -- --backfill
   ```
6. Sources → **Instagram DMs @<username>** turns live; new DMs arrive within 10 minutes.

## Verification

- `tests/api/social.test.ts`: the endpoint and token, threads per conversation per day, matching by handle, unknown
  accounts queued once, redaction and codes, `dm_sources` (phalanx never), adding a handle to an existing person,
  MCP search scoping and `get_party` by handle, the Instagram connect and sync against a fake Instagram API (inline and
  per-message reads, the 20-message window, the cursor, token refresh, a revoked token), and a scan of every table for
  the fixtures' secrets.
- `tests/unit/social.test.ts`: handles, config, the Instagram shapes, and the TikTok collector's logic (time labels,
  what counts as new, state without text) and in-page readers against a stand-in of TikTok's inbox markup.
- The TikTok collector has not been run against the live inbox from here. `--probe` on the Mac is the check: it
  reports what each selector matches, with no message text, and saves the page's structure to
  `~/.strout-vault/tiktok-failures/probe.json`. If TikTok's markup differs, put corrected selectors in
  `~/.strout-vault/tiktok-selectors.json` (same keys as `DEFAULT_SELECTORS` in `collectors/tiktok/page.mjs`).

## Not done here

- **TikTok comments.** Public, so a different job (Apify or the Display API), not part of DM ingest.
- **TikTok's Business Messaging API.** Official and webhook-based, but access goes through TikTok's partner process
  (<https://business-api.tiktok.com/portal/docs>). If it is granted, a worker step like Instagram's can replace the
  collector; the server side (`/api/ingest/social` shape, handles, routing) stays as is.
- **Older Instagram history.** The API stops at 20 messages per conversation. Instagram's "Download your information"
  export (JSON) could be imported the same way; not built.
- **Extraction** of facts from DMs: skipped, like texts, until the message-extraction pass is built.
