# Row counts before and after a fixture import

A local vault (`npm run db:local`: the seed's 40 recordings and 16 parties, plus the three fixture parties
below), then the collector sending the synthetic chat.db over HTTP with an `ingest:messages` token
([collector-dry-run.md](collector-dry-run.md)): once, then a run with nothing new, then `--from-start` (the whole
history again). The fixture parties: Alex Rivera `(205) 555-0142`, Daniel Okafor (seed, phalanx partner) given
`214-555-0166`, and Carol Strout `512.555.0111` with the rule `parties: {18: personal}` in message_routing.yml.

| table | before | after first import | after two more imports |
|---|---:|---:|---:|
| interactions (all) | 40 | 49 | 49 |
| interactions text_thread | 0 | 9 | 9 |
| segments | 4032 | 4046 | 4046 |
| interaction_participants | 90 | 107 | 107 |
| review_queue new_party | 0 | 2 | 2 |
| review_queue workspace_assignment | 0 | 5 | 5 |
| parties | 18 | 18 | 18 |
| import_runs (imessage) | 0 | 1 | 2 |
| chunks | 0 | 0 | 0 |

What the 9 threads are: Kevin McGuire on two Chicago days and the "Conroe crew" group (another_story, by
Kevin's role), Alex Rivera's three chats under three spellings of one number (one party; inbox, since Alex has no
role), Daniel (phalanx: inbox plus a review row suggesting phalanx), Carol (personal, by rule), and an unknown
number whose card number and SSN were stored as `[REDACTED]` (inbox). Skipped and never stored: the short-code
chat (no row at all), the one-time code, the tapback, the group event. The 5 workspace_assignment rows are
Alex x3, Daniel and the unknown number; the 2 new_party rows are the unknown number and the unknown member of
the group chat. `parties` does not change: unknown senders are proposed, never created. The re-imports add only
an `import_runs` row each (the second run sent nothing, so it posted nothing).

`chunks` stays 0 until the embedding step runs: `npx tsx server/worker/index.ts --steps embed` afterwards
embedded all 9 threads (839 chunks across the 46 transcribed interactions, fake provider).
