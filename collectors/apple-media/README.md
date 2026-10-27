# Apple media collector (Voice Memos, call recordings, Notes)

A small Node script that runs on Ben's Mac every 10 minutes. It reads the **iCloud-synced copies** of the
iPhone's Voice Memos, call recordings and Notes on the Mac, **read-only**, and sends them to Strout Vault
(`/api/ingest/device`). The server cannot reach the phone, so this (or the iPhone Shortcut, for when the Mac is
off: [`collectors/ios/SHORTCUT.md`](../ios/SHORTCUT.md)) is how they reach the vault.

| What | Where on the Mac | Becomes |
|---|---|---|
| Voice Memos | `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/` (`CloudRecordings.db` + `.m4a`) | `kind=recording`, `source=voice_memo`, transcribed by the worker |
| iPhone call recordings | notes with audio titled **Call with …** / **Call Recording** in any folder, or anything in a **Call Recordings** folder (`NoteStore.sqlite` + `Accounts/*/Media/…`) | `kind=call`, `source=iphone_call`, transcribed by the worker; Apple's own transcript kept in `source_payload.apple_transcript` for comparison only |
| Apple Notes text | every other Notes folder, subject to the filters below | `kind=note`, `source=apple_note`, searchable and embedded, no media |

What it does on each run:

1. Copies each database (and its `-wal` / `-shm`) into a fresh private temp directory and opens the copy with
   `?mode=ro`. The copy is deleted at the end. Audio files are opened for reading only. **Nothing in an Apple
   container is ever modified, moved or deleted.**
2. Reads the schema first (`pragma table_info`) and stops with a clear message naming the missing columns if it is
   not what the extractor expects. It never guesses silently. `--discover` prints what is really there.
3. For each new recording: SHA-256 of the file, `POST /presign` (the vault answers "already in the vault" when the
   same id or the same bytes are there, e.g. sent from the Shortcut first), PUT straight to R2, `POST /finalize`.
   For each new or edited note: `POST /note` (an edited note updates the same row).
4. Remembers what it sent in `~/.strout-vault/apple-media-state.json`, and opens and closes one batch per run
   (`import_runs`), which is how the **Sources** panel on the Pipeline page knows it checked in.

Output and the log (`~/Library/Logs/strout-vault-apple-media.log`, rotated at 1 MB, three kept) carry counts and
ids only: never a title, a transcript or a word of a note. The server redacts card numbers, SSNs and bank numbers
again whatever the collector sent.

## One job or two? (iMessage)

This is a separate launchd job from the [iMessage collector](../imessage/README.md) (different interval, different
token scope, and the iMessage one is already merged and installed separately). **Full Disk Access is granted to a
node binary, not to a script**, so if both plists use the same node path (they should), the one grant in step 3
covers both.

## Install

You need Node **22.13 or newer** (`node -v`; `brew install node`). There are no npm dependencies.

```sh
# 1. Get the code (or `git pull` if the repo is already on the Mac for the iMessage collector).
git clone https://github.com/bosdesigner/strout-vault.git ~/strout-vault

# 2. Find the real node binary (Full Disk Access is granted to a binary, not to a symlink).
realpath "$(which node)"        # e.g. /opt/homebrew/Cellar/node/23.6.0/bin/node
```

### 3. Grant Full Disk Access to that node binary

macOS protects the Notes and Voice Memos containers. Without this the collector stops with "permission denied …
it needs Full Disk Access".

1. System Settings → Privacy & Security → **Full Disk Access**.
2. Click **+**, press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, paste the path from step 2, choose **Open**.
3. Make sure its switch is on. (Already done for the iMessage collector with the same binary? Nothing to do.)

Also confirm on the iPhone: Settings → [your name] → iCloud → **Notes** and **Voice Memos** are on, so the Mac has
the copies.

### 4. Discover

```sh
cd ~/strout-vault/collectors/apple-media
node collector.mjs --discover | tee ~/Desktop/apple-media-discover.txt
```

It prints the real paths, every table, the columns the extractor reads, row counts, your Notes folder names with
note counts, and `extractor: OK` (or `SCHEMA MISMATCH: …`) for each source. Paste the output into
`docs/ingest-verification/discover-mac.md` (it has no note text). If anything says MISMATCH, stop and send it.

### 5. Filters (optional)

Defaults: skip the Notes folder `Private`, skip notes under 40 characters, skip voice memos under 5 seconds, call
recordings are notes with audio titled "Call with …" or "Call Recording" (or in a `Call Recordings` folder). To change them:

```sh
cp apple-media.example.json ~/.strout-vault/apple-media.json && open -e ~/.strout-vault/apple-media.json
```

| Setting | Default | Meaning |
|---|---|---|
| `skip_folders` | `["Private"]` | Notes folders never sent (case-insensitive) |
| `allow_folders` | `null` | when a list, only these Notes folders are sent (call recordings unaffected) |
| `min_note_chars` | `40` | shorter notes are not sent |
| `min_memo_seconds` | `5` | shorter voice memos are not sent |
| `call_recordings_folder` | `"Call Recordings"` | audio in this folder is a call recording |
| `call_title_detection` | `true` | audio in any folder whose note title starts with "Call" ("Call with Kevin", "Call Recording") is a call recording; the name after "Call with" becomes the participant |
| `include_voice_memos` / `include_call_recordings` / `include_notes` | `true` | switch a source off |

Locked (password-protected) notes and anything in Recently Deleted are never sent. Audio attached to notes in other
folders is never sent (only counted).

### 6. Token, in the Keychain

In the vault, **Agents & API → Personal access tokens → New token**, Kind **Mac media collector**. It carries only
`ingest:device`: it can call `/api/ingest/device/*` and nothing else (no reads, no MCP tools). Copy it, then:

```sh
security add-generic-password -U -s strout-vault -a apple-media -w "$(pbpaste)"
```

The token never sits in a file. (`STROUT_VAULT_TOKEN` in the environment wins over the Keychain, for testing.) The
first launchd run may ask once whether `node` may use the Keychain item: choose **Always Allow**.

### 7. Backfill: dry run first

```sh
export STROUT_VAULT_URL=https://strout-vault.replit.app
node collector.mjs --backfill --dry-run           # counts and total bytes per source; uploads nothing
node collector.mjs --backfill --since 2026-01-01  # or without --since for everything
```

The dry run touches nothing (not even the state file). Without `--backfill`, a run only looks at items from two
days before the first run onwards (plus any note edited since), so installing the launchd job first never uploads
the whole history by surprise.

### 8. Schedule it with launchd

```sh
cp ~/strout-vault/collectors/apple-media/com.stroutvault.apple-media.plist ~/Library/LaunchAgents/
open -e ~/Library/LaunchAgents/com.stroutvault.apple-media.plist
```

Replace `REPLACE_ME_NODE_PATH` (step 2), `REPLACE_ME_REPO` (e.g. `/Users/ben/strout-vault`) and `REPLACE_ME_URL`,
then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stroutvault.apple-media.plist
launchctl kickstart -k gui/$(id -u)/com.stroutvault.apple-media   # run once now
tail -f ~/Library/Logs/strout-vault-apple-media.log
```

To stop: `launchctl bootout gui/$(id -u)/com.stroutvault.apple-media`.

## Flags

| Flag | Meaning |
|---|---|
| `--discover` | print paths, tables, columns, folder names and counts; read-only, sends nothing |
| `--dry-run` | counts and total bytes per source; uploads nothing, leaves the state file alone |
| `--backfill` | every item, not only those since the first run (the server skips what it already has) |
| `--since YYYY-MM-DD` | only items on or after that date |
| `--only voice_memo,iphone_call,apple_note` | limit the sources |
| `--config <file>` / `--state <file>` / `--log-file <file\|->` | other locations |
| `--voice-memos <dir>` / `--notes <dir>` | read other folders (the fixtures in the verification docs) |
| `--url <url>` | instead of `STROUT_VAULT_URL` |

## Notes

- A recording iCloud has not downloaded to the Mac yet is counted as `not_downloaded` and picked up on a later run.
- The same file shared from the iPhone Shortcut first is recognised by its SHA-256 and not uploaded twice. If iOS
  re-encodes a file when sharing it, the bytes differ and the vault would hold both; the Shortcut doc says how to
  share the original.
- Deleting a note or memo on the phone never deletes anything in the vault.
