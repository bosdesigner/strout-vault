# TikTok DM collector

A Node script that runs on Ben's Mac every 30 minutes. TikTok has no API for an account's own DMs (its Business
Messaging API is partner-only), so this reads the web inbox the way a person would: in **its own Chrome profile**,
signed in once by hand, it opens <https://www.tiktok.com/messages>, opens each conversation whose list row changed
since the last run, reads the messages on screen, and sends the new ones to Strout Vault
(`POST /api/ingest/social`). The server matches people by handle, redacts and routes them like texts
([`docs/SOCIAL_DMS.md`](../../docs/SOCIAL_DMS.md)).

It only reads: it never types, sends, likes, accepts a request or deletes anything. **One side effect:** opening a
conversation in TikTok's web inbox marks it read, on the phone too. Unread badges are how TikTok tells you what is new,
so after this is running, use Jarvis (or the vault's Inbox) as the "what's new" list instead.

Output is counts only. Message text is never printed or written on the Mac; the state file
(`~/.strout-vault/tiktok-state.json`) keeps hashes of what was seen, never the text.

## Install

Needs Node 20+ and Google Chrome (the collector drives your installed Chrome; nothing else is downloaded).

```sh
cd ~/strout-vault && git pull
cd collectors/tiktok
npm ci
```

### 1. Token

In the vault, <https://strout-vault.replit.app/agents> → **Personal access tokens → New token**, Kind **TikTok DM
collector: send DMs only**. It can post to `/api/ingest/social` and nothing else. Then on the Mac:

```sh
mkdir -p ~/.strout-vault && chmod 700 ~/.strout-vault
pbpaste > ~/.strout-vault/tiktok-token && chmod 600 ~/.strout-vault/tiktok-token
```

### 2. Sign in once

```sh
node collector.mjs --login
```

A Chrome window opens on TikTok. Sign in as **@hemakesbigmoves** (QR code from the phone is easiest). When the inbox
shows, the script says so and exits. The session lives in `~/.strout-vault/tiktok-profile`, separate from your everyday
Chrome. If TikTok signs it out later, Sources says "signed out"; run `--login` again.

### 3. Probe: does it read the inbox?

```sh
node collector.mjs --probe --account hemakesbigmoves
```

Prints how many conversation rows it found, whether it could read the first conversation's username, how many messages
(and how many were yours), and what each selector matched. No message text. It also saves the page's structure (tags,
classes, `data-e2e` names; no text) to `~/.strout-vault/tiktok-failures/probe.json`.

What good looks like: rows > 0, "username found", messages > 0 with some of them yours and most with a time label.
If something reads 0, TikTok's markup differs from the defaults: send `probe.json` to Claude, and put corrected
selectors in `~/.strout-vault/tiktok-selectors.json` (same keys as `DEFAULT_SELECTORS` in `page.mjs`; only the keys you
change). No code change or reinstall needed.

### 4. Dry run

```sh
node collector.mjs --dry-run --account hemakesbigmoves --all
```

Opens every conversation (this marks them read), prints per conversation how many messages are on screen, how many are
new and how many are yours. Sends nothing, keeps no state.

### 5. Schedule it

```sh
cp com.stroutvault.tiktok.plist ~/Library/LaunchAgents/
open -e ~/Library/LaunchAgents/com.stroutvault.tiktok.plist
```

Replace `REPLACE_ME_NODE_PATH` (`which node`), `REPLACE_ME_REPO` (e.g. `/Users/ben/strout-vault`) and
`REPLACE_ME_URL` (`https://strout-vault.replit.app`). Then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stroutvault.tiktok.plist
launchctl kickstart gui/$(id -u)/com.stroutvault.tiktok      # one run now
tail -f /tmp/strout-vault-tiktok.log
```

The first scheduled run reads every conversation (scrolling up for older messages) and sends them; later runs open
only conversations whose row changed. Sources (<https://strout-vault.replit.app/pipeline>) → **TikTok DMs** shows the
last batch, counts, and a warning if the collector has been silent for two hours.

Runs headless by default. If TikTok refuses the headless browser (Sources says signed out right after a good
`--login`), set `TIKTOK_HEADED` to `1` in the plist: a window then appears for a minute every half hour.

## Options

| | |
|---|---|
| `--login` | visible window, wait for you to sign in |
| `--probe` | what the selectors match; no text, nothing sent |
| `--dry-run` | read and count; nothing sent, no state written |
| `--all` | open every conversation, not only changed ones |
| `--max N` | open at most N conversations this run (default 40) |
| `--headed` | show the window |
| `--account u` | your username (or `TIKTOK_ACCOUNT`) |

Uninstall: `launchctl bootout gui/$(id -u)/com.stroutvault.tiktok`, then delete the plist and `~/.strout-vault/tiktok-*`.

## How it decides what is new

TikTok's web inbox shows no message ids and no per-message times, only time labels between groups ("Today 8:00 AM").
For each conversation the collector keeps the hashes of the last 60 messages it sent (who wrote it + what it says).
On the next read, the messages after the newest stretch that matches those hashes are new. Each new message gets an
id `u-<username>:<n>` that never changes, and the time of the label above it (or the time of the run, when there is
none). If a conversation's screen does not line up with what was seen, only messages whose hash was never seen are
sent. The vault merges by id, so a resend writes nothing.
