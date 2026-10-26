# iMessage collector dry run (synthetic chat.db)

The synthetic chat.db is `tests/fixtures/imessage/chatdb.ts` (made-up 555 numbers, never real messages):
18 messages across 9 chats, one body stored only in `attributedBody`, a tapback, a group event, a short-code
sender and a one-time code.

```
$ npx tsx scripts/build-synthetic-chatdb.ts /tmp/synthetic-chat.db
wrote /tmp/synthetic-chat.db (18 synthetic messages)

$ node collectors/imessage/collector.mjs --dry-run --from-start --db /tmp/synthetic-chat.db --state /tmp/state.json
[imessage] DRY RUN: nothing was sent and the state file was not touched
[imessage] would send 14 message(s) from 8 conversation(s), ROWID 1..18
  conversation                       messages  from me  days attach
  +19365550142                              6        2     2      1
  Conroe crew                               2        0     1      0
  (205) 555-0142                            1        0     1      0
  205.555.0142                              1        0     1      0
  +12055550142                              1        0     1      0
  +12145550166                              1        0     1      0
  +15125550111                              1        0     1      0
  +17135550199                              1        0     1      0
[imessage] skipped on the Mac: reaction 1, short_code 1, one_time_code 1, system 1

$ ls /tmp/state.json
ls: cannot access '/tmp/state.json': No such file or directory
```

"days" counts America/Chicago days, the way the vault files texts: Kevin's six messages span three UTC dates
but two Chicago days, so they become two `text_thread` rows.

## The same chat.db sent for real (to a local vault)

```
$ STROUT_VAULT_URL=http://localhost:3000 STROUT_VAULT_TOKEN=<ingest token> node collectors/imessage/collector.mjs --db /tmp/synthetic-chat.db --state /tmp/state.json
[imessage] sent 14 message(s): 9 new thread(s), 0 updated, 0 unchanged
[imessage] done: 14 message(s) sent from 8 conversation(s); last ROWID 18
[imessage] skipped on the Mac: reaction 1, short_code 1, one_time_code 1, system 1

$ # again: nothing new since ROWID 18
[imessage] done: 0 message(s) sent from 0 conversation(s); last ROWID 18
[imessage] skipped on the Mac: nothing

$ # and the whole history once more (--from-start): the server writes nothing
[imessage] sent 14 message(s): 0 new thread(s), 0 updated, 9 unchanged
[imessage] done: 14 message(s) sent from 8 conversation(s); last ROWID 18
[imessage] skipped on the Mac: reaction 1, short_code 1, one_time_code 1, system 1
```
