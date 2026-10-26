# Texts + email: verification

1. [test-output.md](test-output.md): the new unit and API suites (verbose) and the whole suite, 261 tests passing.
2. [collector-dry-run.md](collector-dry-run.md): the iMessage collector's `--dry-run` against the **synthetic**
   chat.db (never real messages), then the same file sent for real to a local vault, twice more to show nothing is
   written again.
3. [inspector-transcripts.md](inspector-transcripts.md): the MCP Inspector calling `search_conversations` with an
   Another Story token: it finds the fixture text thread, and finds nothing for the fixture phalanx thread (filed to
   `inbox`), which `get_interaction` also refuses; a token that names inbox finds it.
4. [row-counts.md](row-counts.md): row counts before and after the fixture import, and after re-importing.

Reproduce locally (no secrets needed):

```bash
npm run db:local                                    # local Postgres, migrations 0001-0009, seed, .env
npx tsx scripts/build-synthetic-chatdb.ts /tmp/synthetic-chat.db
node collectors/imessage/collector.mjs --dry-run --from-start --db /tmp/synthetic-chat.db --state /tmp/state.json
OWNER_EMAILS=ben@example.com OWNER_PHONES="+1 713 555 0100" npm run dev
# sign in, Agents & API → New token → Kind "iMessage collector"; then:
STROUT_VAULT_URL=http://localhost:3000 STROUT_VAULT_TOKEN=svt_... node collectors/imessage/collector.mjs --db /tmp/synthetic-chat.db --state /tmp/state.json
npx tsx server/worker/index.ts --steps embed
BASE=http://localhost:3000 STORY_TOKEN=svt_... FULL_TOKEN=svt_... PHALANX_ID=<id> scripts/messages-inspector-transcripts.sh
```

(The verification run also added three fixture parties first; see row-counts.md.)
