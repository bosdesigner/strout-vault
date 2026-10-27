# Collector `--dry-run` against the fixtures, and the Apple files before and after

Fixture copies of `CloudRecordings.db` + `.m4a` files and `NoteStore.sqlite` + `Accounts/*/Media` (built by
`tests/fixtures/apple-media/build.ts`; made-up content). The dry run uploads nothing and does not write the state
file; it prints counts and total bytes per source and never a title or a word of a note.

```
$ node collectors/apple-media/collector.mjs --dry-run --backfill --voice-memos <fixture>/…/Recordings --notes <fixture>/group.com.apple.notes
[apple-media] DRY RUN: nothing was uploaded and the state file was not touched (backfill: every item, not just new ones)
  source       would send          bytes already sent  skipped
  voice_memo            1          54041            0  not_downloaded 1, deleted 1, short 1
  iphone_call           2         117009            0  none
  apple_note            2            210            0  folder_skipped 1, short 1, locked 1, deleted 1
  (1 audio attachment(s) in Notes folders other than "Call Recordings" are never sent)
```

SHA-256 of every Apple file before the dry run (and of the `--discover` run before it):

```
f7d8ef9fd72020e6efb215a04d5efc42630bb92ea8cc86cb55934ef04b617ccf  ./group.com.apple.VoiceMemos.shared/Recordings/20261019 080000-DELETED0.m4a
9d04303f259235ea00a35a7a608e4c5dbd48629355c2e5b28584ce4e4a657fbb  ./group.com.apple.VoiceMemos.shared/Recordings/20261020 091500-A1B2C3D4.m4a
adbf1b84a73f535347ee2f57afd90231732a055b98a79dc5ab6721afc87287aa  ./group.com.apple.VoiceMemos.shared/Recordings/20261020 101500-SHORT000.m4a
032820db3855ba91e67e91ae00fee12e3c3f43d9a22e3f9b524017d759863e80  ./group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db
498e13486843708488c18a899a405a38a50cb2b1a3f8bf658f380768b1edab18  ./group.com.apple.notes/Accounts/6F1C7E1A-0000-4000-8000-ACC000000001/Media/MEDIA-CALL-0001/1_7A2B/Call with Kevin McGuire.m4a
3f0b5dd968b5d8671cc2ca66cb48e8786bdd85708f747722210ca6dcf9587983  ./group.com.apple.notes/Accounts/6F1C7E1A-0000-4000-8000-ACC000000001/Media/MEDIA-CALL-0002/1_9C3D/Call.m4a
91549f7917eb017f77e260482b9d3b4d8c15fa9b2c888a64b26702546f06d803  ./group.com.apple.notes/Accounts/6F1C7E1A-0000-4000-8000-ACC000000001/Media/MEDIA-OTHER-0001/Audio.m4a
0e7371b805c8b4e43e02124538fa4e695dc39332ea9b9168862b7cf0855bc2ef  ./group.com.apple.notes/NoteStore.sqlite
```

**After: identical** (`diff` of the two listings is empty). The same check runs in `tests/unit/apple-media.test.ts` (dry run, discover, each parser) and `tests/api/ingest-e2e.test.ts` (three real runs that upload to a local vault).
