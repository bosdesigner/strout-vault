# Texts and email (Jarvis step 4)

Ben's iMessage/SMS texts and his Gmail come into the vault as interactions, linked to the people
the vault already knows and filed under the right workspace. They then go through the same
embedding, search and MCP path as calls, so Jarvis can answer "what did Kevin text me about
Conroe?" the way it answers questions about meetings.

Everything here is **read-only toward Ben's accounts**: nothing sends, replies, deletes, labels,
archives or marks anything read. Gmail is reached with the `gmail.readonly` scope and nothing else.

## What lands where

| | Texts | Email |
|---|---|---|
| Collected by | a Node script on Ben's Mac every 15 minutes ([`collectors/imessage`](../collectors/imessage/README.md)) | the worker's `gmail` step every 10 minutes |
| One interaction per | conversation per local day (America/Chicago) | Gmail thread |
| `kind` / `source` | `text_thread` / `imessage` | `email_thread` / `gmail` |
| `source_ref` | `imessage:<chat_guid>:<YYYY-MM-DD>` | `gmail:<account>:<threadId>` |
| `title` | "Texts with Kevin McGuire · 2026-10-20" (or the group's name) | the subject |

Each message is one `segments` row: `speaker` is the display name (Ben's own messages say `Ben`),
`speaker_party_id` the matched party, `start_sec` seconds since the thread's first message. The
`transcript` is rebuilt as `[HH:MM] Name: text` lines (Chicago time), so the chunker, the full-text
index and every MCP tool work unchanged. `source_payload.messages` keeps per-message metadata (id,
time, sender identifier, attachment name/type/size) but never bodies twice and never attachment bytes.

Email bodies are the **plain-text part only**, with quoted replies and signatures removed by
[`email-reply-parser`](https://github.com/crisp-oss/email-reply-parser).

**Idempotent.** Threads are upserted on `(source, source_ref)`. `content_sha256` covers the message
ids and bodies; a re-import that brings nothing new writes nothing. A later batch for the same day,
or a new message in a Gmail thread, updates the one row, rewrites its segments and sets a fresh
`pipeline_updated_at`, which puts it back in the existing embedding step's queue.

## Never stored

Checked before anything is written, on the server, whatever the collector already did:

| Filter | Applies to | `import_runs.counts_out.skipped` key |
|---|---|---|
| Gmail Promotions / Social / Updates / Forums | email | `category_promotions` … `category_forums` |
| a `List-Unsubscribe` header | email | `list_unsubscribe` |
| drafts, spam, trash | email | `draft`, `spam_trash` |
| senders in `config/message_blocklist.yml` | both | `blocklist` |
| SMS short codes (5-6 digit senders) | both | `short_code` |
| one-time codes (`\b\d{4,8}\b` next to code / verification / OTP / passcode) | texts: the message is dropped; email: dropped when short or the subject says so, otherwise only the digits are replaced | `one_time_code` |

And in whatever is kept, card numbers (Luhn-valid 13-19 digits), SSNs, and bank routing/account
numbers become `[REDACTED]` before any write: bodies, subjects, display names and attachment names
alike. Message text is never logged; runs log counts only. `tests/api/messages.test.ts` scans every
table and every log line of an import for the fixture's card number, SSN and code.

## People

Phones are normalised to E.164 (`libphonenumber-js`, default region US) and emails lowercased, then
matched against `parties.phones` / `parties.emails`. A match fills `speaker_party_id` and adds an
`interaction_participants` row. **No party is ever created.** Each unknown phone or email gets one
`review_queue` row (`item_type = 'new_party'`), with the identifier, display name, message count and
first/last seen under `proposal.evidence`. Repeat imports refresh the counts on an open row and never
re-queue a sender you rejected. Approving it creates the party and points every stored message from
that identifier at it.

Ben's own identifiers come from `OWNER_PHONES` and `OWNER_EMAILS` (plus each connected Gmail
address). They are never queued and never decide a workspace.

## Workspaces

A **new** thread is routed once:

1. Each matched participant contributes its rule in `config/message_routing.yml` if there is one,
   otherwise every workspace it has a role in: directly (`roles`), through a current affiliation
   with an org that has a role, or on a project (`project_parties`). Email addresses that contribute
   nothing fall back to the domain rules in the same file.
2. Exactly one workspace: the thread is filed there.
3. Several: `inbox`, plus a `workspace_assignment` review row suggesting the most common one.
4. None (nobody known is on it): `inbox`, with **no** review row. It waits there until its people
   are known (below).
5. **phalanx is never assigned automatically**, even from a rule: the thread goes to `inbox` with
   phalanx suggested.

**Inbox files itself as people become known.** After you approve a new person, add a role, or link
someone to a company (and once an hour in the worker's `refile` step), every item still in `inbox`
(texts, email, voice memos, calls, notes, Meet) is routed again by the rules above; one that now maps
to exactly one workspace is filed there, and any open `workspace_assignment` row for it is closed.
Only items still in `inbox` are ever moved, so nothing you filed by hand changes, and phalanx is
never chosen automatically (`server/workspaces/refile.ts`).

Updates keep the thread's workspace (yours, if you moved it). Approving a `workspace_assignment`
files the thread. `personal` (family and personal threads) and `inbox` are new workspaces and, like
phalanx, **never part of a `"*"` token scope**: a token sees them only if they are named on it.

Both YAML files ship with commented examples only. Fill them in; the server and the worker read
them on every import.

## Turning it on

(These steps are also in [`docs/INGEST.md`](INGEST.md), the one checklist for every ingest point.)

1. Apply `db/migrations/0009_messages.sql` (after 0008) in the Neon SQL editor. It widens the
   `interactions.kind` check, adds the `personal` and `inbox` workspaces, `api_tokens.scopes`,
   `message_accounts`, and three indexes. `/api/health` then reports `v0.9`.
2. Secrets on **both** Repls (web and worker): `OWNER_PHONES`, `OWNER_EMAILS`,
   `MESSAGES_ENCRYPTION_KEY` (32 random bytes, hex), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
3. **Google OAuth client.** In Google Cloud Console create an OAuth client (Web application) with the
   redirect URI `<PUBLIC_URL>/api/messages/gmail/callback`, enable the Gmail API, and add the
   `gmail.readonly` scope to the consent screen (in testing mode, add Ben's addresses as test users).
4. **Connect each account.** Signed in to the vault, open `<PUBLIC_URL>/api/messages/gmail/connect`
   once per Gmail account. The callback refuses any grant broader than `gmail.readonly` and stores
   the refresh token encrypted (AES-256-GCM). `GET /api/messages/accounts` lists accounts, their sync
   state and the latest runs.
5. **The near-real-time sync.** With the one-app setup (README step 6, `RUN_WORKER=1`), the `gmail` step runs
   every 5 minutes alongside `link`, `classify` and `embed`. Those steps take their own locks, so this never
   waits for (or doubles up with) the hourly full run. A new account's first run only records where Gmail's
   history is; the backfill fills in the past.
6. **Backfill**, by hand, from a Repl shell (the worker's is fine):
   ```bash
   npm run messages:gmail -- --account ben@example.com --since 30 --dry-run   # counts only, writes nothing
   npm run messages:gmail -- --account ben@example.com --since 30
   npm run messages:gmail -- --account ben@example.com --since 365
   ```
   Resumable: the page cursor lives in `worker_state`, so a stopped run continues where it was, and
   threads already imported are skipped as unchanged.
7. **Texts**: install the collector on the Mac ([`collectors/imessage/README.md`](../collectors/imessage/README.md)).
   It authenticates with a personal access token of kind **iMessage collector** (scope
   `ingest:messages`), made on the Agents & API page. That token can POST `/api/ingest/messages` and
   nothing else: it reads nothing and every MCP call with it is refused.

## For agents

`search_conversations` and `list_interactions` take `kind` (`text_thread`, `email_thread`, or the
recording kinds) and return the new kinds like any other. `get_interaction` reads a thread's
messages as transcript lines; `start_sec` counts from the first message. Scope is enforced exactly
as for recordings.

## Not done here

- Fact and commitment extraction from messages: the extraction step skips `text_thread` and
  `email_thread` until its own pass is built.
- Contact names from the Mac's address book: the collector sends handles only; names come from parties.
- Gmail costs quota units, not money, so nothing is written to `spend_ledger`.
