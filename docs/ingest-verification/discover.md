# `--discover`

## On the Mac (to fill in)

Run this on the Mac after granting Full Disk Access and paste the whole output below. It prints paths, table and
column names, row counts and Notes folder names; never note text, titles of notes or transcripts.

```sh
cd ~/strout-vault/collectors/apple-media && node collector.mjs --discover
```

```
(paste here)
```

## Against the fixtures (what the output looks like, and what the extractor expects)

```
strout-vault apple-media --discover  (2026-10-27T05:07:45.431Z, macOS Linux 6.18.44-fc-v165, node v22.22.0)

Voice Memos
  <fixture>/group.com.apple.VoiceMemos.shared/Recordings: readable
    audio files in folder: 3
    CloudRecordings.db: 2 table(s): ZCLOUDRECORDING, ZFOLDER
    ZCLOUDRECORDING (4 row(s)): Z_PK, Z_ENT, Z_OPT, ZFLAGS, ZDATE, ZDURATION, ZEVICTIONDATE, ZCUSTOMLABEL, ZCUSTOMLABELFORSORTING, ZENCRYPTEDTITLE, ZPATH, ZUNIQUEID, ZFOLDER
    ZFOLDER (0 row(s)): Z_PK, ZENCRYPTEDNAME, ZUUID
    extractor: OK (4 recording(s): not_downloaded 1, deleted 1, ok 2)

Notes (call recordings + text notes)
  <fixture>/group.com.apple.notes: readable
    Accounts/: 1 account folder(s): 6F1C7E1A-0000-4000-8000-ACC000000001
    NoteStore.sqlite: 3 table(s): ZICCLOUDSYNCINGOBJECT, ZICNOTEDATA, Z_PRIMARYKEY
    ZICCLOUDSYNCINGOBJECT (20 row(s)): Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZNAME, ZTITLE1, ZTITLE2, ZFOLDER, ZFOLDERTYPE, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZISPASSWORDPROTECTED, ZMARKEDFORDELETION, ZACCOUNT3, ZACCOUNT4, ZTYPEUTI, ZNOTE, ZMEDIA, ZFILENAME, ZDURATION, ZADDITIONALINDEXABLETEXT, ZNOTEDATA
    ZICNOTEDATA (8 row(s)): Z_PK, Z_ENT, Z_OPT, ZNOTE, ZDATA, ZCRYPTOTAG
    attachment types: com.apple.m4a-audio 3
    folders (notes per folder; use these names in ~/.strout-vault/apple-media.json):
      Notes: 3
      Call Recordings: 2
      Private: 1
      Recently Deleted: 1
      Another Story: 1
    extractor: OK (6 text note(s): ok 4, locked 1, deleted 1; 2 call recording(s) in "Call Recordings": ok 2; 1 audio attachment(s) in other folders, not sent)
```
