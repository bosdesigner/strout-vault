# "Send to Vault": an iPhone Shortcut for call recordings and voice memos

For when the Mac is off (or asleep for days): share a call recording or a voice memo from the iPhone and it lands
in the vault the same way the Mac media collector would send it. The Mac collector later finds the same file and
skips it (same SHA-256), so nothing arrives twice.

The Shortcut makes three requests, each one shown below with a `curl` you can run first to test the endpoint:
`POST /api/ingest/device/presign` → `PUT` the audio straight to storage → `POST /api/ingest/device/finalize`.

## 1. Token

In the vault, **Agents & API → Personal access tokens → New token**, Kind **iPhone Shortcut**. It carries only
`ingest:device` (no reads, no MCP). Shortcuts has no Keychain, so the token lives inside the Shortcut: keep the
Shortcut unshared and revoke the token from the same page if the phone is lost.

## 2. Build the Shortcut

New Shortcut, name it **Send to Vault**. In its details (ⓘ): turn on **Show in Share Sheet**, Share Sheet types:
**Media** and **Files** only. Then add these actions, in order:

| # | Action | Settings |
|---|---|---|
| 1 | **Receive** *Media and Files* input from *Share Sheet* | If there's no input: *Stop and Respond* |
| 2 | **Text** | your vault address, e.g. `https://strout-vault.replit.app`. Rename the variable **Vault** |
| 3 | **Text** | the token (`svt_…`). Rename the variable **Token** |
| 4 | **Choose from Menu** | prompt "What is it?", items **Call recording** and **Voice memo**. Under *Call recording* add **Text** `iphone_call`; under *Voice memo* add **Text** `voice_memo`. After the menu, add **Set Variable** **Source** to *Menu Result* |
| 5 | **Generate Hash** | of *Shortcut Input*, type **SHA256**. Set Variable **Hash** |
| 6 | **Get Details of Files** | *File Size* of *Shortcut Input* → **Format File Size** with format **Bytes**, then **Get Numbers from Input** (strips "bytes" and separators). Set Variable **Bytes** |
| 7 | **Get Details of Files** | *Name* of *Shortcut Input*. Set Variable **Name** |
| 8 | **Get Details of Files** | *Creation Date* of *Shortcut Input* → **Format Date**, format **ISO 8601**, include time. Set Variable **When** |
| 9 | **Ask for Input** | (only meaningful for calls) prompt "Who was it with?", type Text, default empty. Set Variable **Who** |
| 10 | **Get Contents of URL** | URL `Vault`/api/ingest/device/presign, Method **POST**, Headers `Authorization` = `Bearer Token`, Request Body **JSON**: `source` = Source, `source_ref` = `shortcut:`Hash, `sha256` = Hash, `bytes` (Number) = Bytes, `filename` = Name.m4a (see note), `content_type` = `audio/mp4`, `single_part` (Boolean) = true |
| 11 | **Get Dictionary Value** | `duplicate` from *Contents of URL* |
| 12 | **If** *Dictionary Value* is `1` (true) | **Show Notification** "Already in vault" → **Stop This Shortcut**. **End If** |
| 13 | **Get Dictionary Value** | `parts` from the presign result → **Get Item from List** *First Item* → **Get Dictionary Value** `url`. Set Variable **PartURL** |
| 14 | **Get Dictionary Value** | `key` from the presign result → Set Variable **Key**; and `upload_id` → Set Variable **UploadId** |
| 15 | **Get Contents of URL** | URL **PartURL**, Method **PUT**, Request Body **File** = *Shortcut Input*. No headers |
| 16 | **Get Contents of URL** | URL `Vault`/api/ingest/device/finalize, Method **POST**, Header `Authorization` = `Bearer Token`, Request Body **JSON**: `source`, `source_ref`, `sha256`, `bytes`, `filename`, `content_type` as in step 10, plus `key` = Key, `upload_id` = UploadId, `occurred_at` = When, `title` = (empty, or "Call with Who"), `participants_raw` (Array) = one Dictionary `name` = Who |
| 17 | **Get Dictionary Value** | `interaction_id` from *Contents of URL*. **If** it has any value: **Show Notification** "Saved", **Otherwise** **Show Notification** "Not saved: " + *Contents of URL* |

Notes:

- **filename**: the vault accepts `m4a, mp3, wav, aac, caf, qta, mp4, mov`. Voice Memos shares `.m4a`; a call
  recording shared from Notes is `.m4a` too. If *Name* has no extension, append `.m4a`.
- The `PUT` URL is presigned (it expires in an hour) and needs no token. The vault completes the upload from the
  storage's own list of parts, so the Shortcut never has to read response headers.
- **Duplicates**: the same file sent again (from the Shortcut or later by the Mac collector) is answered
  `{"duplicate": true}` at step 10 and nothing is uploaded. This relies on the bytes being identical: share the
  recording itself (the Share button on the memo or on the audio attachment in Notes), not an exported or trimmed
  copy.
- The counterparty you type in step 9 is matched against People (a phone number or email matches exactly; a name
  matches only when exactly one person has it). Unknown names are kept on the recording, never turned into people.
- Each send is its own batch on the Pipeline page's **Sources** panel (row "iPhone Shortcut").

## 3. The same requests with curl (test the endpoint first)

```sh
VAULT=https://strout-vault.replit.app
TOKEN=svt_...                               # the iPhone Shortcut token
F=call.m4a
SHA=$(shasum -a 256 "$F" | cut -d' ' -f1); BYTES=$(wc -c < "$F" | tr -d ' ')

# 1. presign (or: {"duplicate": true, "interaction_id": …} and stop)
curl -s -X POST $VAULT/api/ingest/device/presign -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"source\":\"iphone_call\",\"source_ref\":\"shortcut:$SHA\",\"sha256\":\"$SHA\",\"bytes\":$BYTES,\"content_type\":\"audio/mp4\",\"filename\":\"$F\",\"single_part\":true}" | tee presign.json

# 2. PUT the bytes to the presigned URL
curl -s -o /dev/null -w '%{http_code}\n' -X PUT --data-binary @"$F" "$(jq -r '.parts[0].url' presign.json)"

# 3. finalize
curl -s -X POST $VAULT/api/ingest/device/finalize -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"source\":\"iphone_call\",\"source_ref\":\"shortcut:$SHA\",\"sha256\":\"$SHA\",\"bytes\":$BYTES,\"key\":\"$(jq -r .key presign.json)\",\"upload_id\":\"$(jq -r .upload_id presign.json)\",\"content_type\":\"audio/mp4\",\"filename\":\"$F\",\"occurred_at\":\"$(date -u +%FT%TZ)\",\"participants_raw\":[{\"name\":\"Kevin McGuire\"}]}"
```

A transcript of these requests succeeding against a local vault is in
[`docs/ingest-verification/shortcut-curl.md`](../../docs/ingest-verification/shortcut-curl.md).
