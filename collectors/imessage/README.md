# iMessage / SMS collector

A small Node script that runs on Ben's Mac every 15 minutes. It reads `~/Library/Messages/chat.db`
**read-only** and sends new texts to Strout Vault (`POST /api/ingest/messages`). The server cannot read
the phone, so this is the only way texts reach the vault. It never sends, deletes or marks anything.

What it does on each run:

1. Copies `chat.db` and its `-wal` / `-shm` files into a fresh private temp directory and opens the copy
   with `?mode=ro`, so Messages.app is never locked or written to. The copy is deleted at the end.
2. Reads messages with `ROWID` greater than the last one sent (kept in `~/.strout-vault/imessage-state.json`).
3. Decodes `attributedBody` when `text` is null (newer macOS keeps the body only there) with
   [`node-typedstream`](https://www.npmjs.com/package/node-typedstream), and converts Apple timestamps
   (nanoseconds since 2001-01-01) to UTC.
4. Leaves on the Mac: tapbacks/reactions, group events, SMS short codes (5-6 digit senders) and anything that
   looks like a one-time code. The server applies the same filters again (and redacts card numbers, SSNs and
   bank numbers), so nothing depends on this step.
5. Sends what is left in batches of 500 with the ingest token, then records the last `ROWID`.

Attachments are sent as metadata only (file name, type, size); the files themselves never leave the Mac.
Output is counts only: message text is never printed or logged.

## Install

You need Node **22.13 or newer** (for the built-in `node:sqlite`). `node -v` to check; `brew install node`
if it is older.

```sh
# 1. Get the code (or pull, if the repo is already on the Mac) and install the one dependency.
git clone https://github.com/bosdesigner/strout-vault.git ~/strout-vault
cd ~/strout-vault/collectors/imessage
npm ci

# 2. Find the real node binary (Full Disk Access is granted to a binary, not to a symlink).
realpath "$(which node)"        # e.g. /opt/homebrew/Cellar/node/23.6.0/bin/node
```

### 3. Grant Full Disk Access to that node binary

macOS protects `~/Library/Messages`. Without this the collector stops with "chat.db not found (or Full Disk
Access is missing)".

1. System Settings → Privacy & Security → **Full Disk Access**.
2. Click **+**, press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd>, paste the path from step 2, choose **Open**.
3. Make sure its switch is on.

After a Homebrew upgrade the Cellar path changes: add the new binary and update the plist (step 6).

### 4. Create the token

In the vault, **Agents & API → Personal access tokens → New token**, Kind **iMessage collector: send texts
only**. That token carries only `ingest:messages`: it can post to `/api/ingest/messages` and nothing else (no
reads, no MCP tools). Copy it, then on the Mac:

```sh
mkdir -p ~/.strout-vault && chmod 700 ~/.strout-vault
pbpaste > ~/.strout-vault/imessage-token && chmod 600 ~/.strout-vault/imessage-token
```

(`STROUT_VAULT_TOKEN` in the environment works too and wins over the file.)

### 5. Dry run first

```sh
cd ~/strout-vault/collectors/imessage
node collector.mjs --dry-run --from-start
```

This reads the whole history and prints what **would** be sent: counts per conversation (messages, how many
are yours, days, attachments) and what was skipped on the Mac. Nothing is sent and the state file is not
touched. Drop `--from-start` to preview only what is new since the last real run.

### 6. Schedule it with launchd

```sh
cp ~/strout-vault/collectors/imessage/com.stroutvault.imessage.plist ~/Library/LaunchAgents/
open -e ~/Library/LaunchAgents/com.stroutvault.imessage.plist
```

Replace the three placeholders:

| Placeholder | Value |
|---|---|
| `REPLACE_ME_NODE_PATH` | the path from step 2 (the binary with Full Disk Access) |
| `REPLACE_ME_REPO` | e.g. `/Users/ben/strout-vault` |
| `REPLACE_ME_URL` | the vault's address, e.g. `https://strout-vault.replit.app` |

Then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stroutvault.imessage.plist
launchctl kickstart -k gui/$(id -u)/com.stroutvault.imessage   # run once now
tail -f /tmp/strout-vault-imessage.log
```

The first real run sends the whole history (in batches of 500). If you would rather start from today, write the
current maximum `ROWID` to the state file before loading the plist:

```sh
sqlite3 -readonly ~/Library/Messages/chat.db 'select max(ROWID) from message' \
  | xargs -I{} sh -c 'echo "{\"last_rowid\": {}}" > ~/.strout-vault/imessage-state.json'
```

To stop: `launchctl bootout gui/$(id -u)/com.stroutvault.imessage`.

## Flags

| Flag | Meaning |
|---|---|
| `--dry-run` | print counts per conversation, send nothing, leave the state file alone |
| `--from-start` | ignore the state file (with `--dry-run`: preview everything) |
| `--db <path>` | read another chat.db (the synthetic fixture in the verification docs) |
| `--state <path>` | where the last ROWID is kept |
| `--token-file <path>` | where the token is read from (default `~/.strout-vault/imessage-token`) |
| `--url <url>` | instead of `STROUT_VAULT_URL` |

## Notes

- Names: the collector sends phone numbers and emails, not your Contacts. The vault names a sender from the
  matching party (People page); an unknown number is queued on the Review page as a possible new person.
- A message edited or unsent after it was collected keeps the version that was sent.
- Re-sending is harmless: the server merges by message id and writes nothing when a day's thread is unchanged.
