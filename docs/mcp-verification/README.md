# MCP server + semantic search: verification

What was checked for the `feat/mcp-server` build (Jarvis step 1), and where to look. Everything ran
against a local Postgres 16.15 with pgvector 0.6.0 (the compose file provides pgvector/pgvector:pg17 for
anyone running it with Docker), the seeded database (`db/seed.sql`) and the deterministic fake
embedding provider. Nothing touched Neon, R2 or any embedding API.

| Artifact | File |
|---|---|
| Unit + API test output (the whole suite, old and new) | [`test-output.md`](test-output.md) |
| MCP Inspector transcripts, every tool called (plus an invalid proposal and two scope refusals) | [`inspector-transcripts.md`](inspector-transcripts.md) |
| The JSON each tool returned in that run | [`sample-responses.md`](sample-responses.md) |
| Semantic-search quality check (five paraphrased queries) | [`semantic-check.md`](semantic-check.md) |
| Backfill dry run on the seed | below |

## What the tests cover

`tests/unit/chunker.test.ts` (7): no segment is ever split and chunks are contiguous and ordered;
overlap is ≤ 15% of the previous chunk's tokens on whole segments and never leaves a gap; chunks stop
at ~400 tokens or 120 s, whichever fills first; `start_sec`/`end_sec` come from the first and last
source segment; speaker turns are prefixed; empty, huge, unordered and blank segments; determinism.

`tests/unit/embeddings.test.ts` (8): the fake provider is deterministic, 1024-dimensional and unit
length; vector literal and token estimate; batching by count and tokens; retry on 429 (honouring
Retry-After) and 5xx, immediate failure on other 4xx, `maxAttempts`; the Voyage request shape
(model, `input_type`, bearer key, ordered results, `output_dimension` only when needed, token
accounting) and dimension checking; the OpenAI request shape (`dimensions: 1024`).

`tests/unit/mcp-scope.test.ts` (7): stored-scope validation; `*` never includes phalanx unless
listed; the SQL predicate and `false` for an empty scope; the sliding-window limiter; audit redaction;
personal-token hashing; the signed consent request (tamper and expiry).

`tests/api/mcp.test.ts` (30, own database `strout_vault_mcp`, real HTTP on :3998, the MCP TypeScript
client SDK for every tool call):

- **auth**: missing, malformed, unknown, revoked and expired tokens → 401 with the
  `resource_metadata` discovery header; only a hash and a prefix are stored; token pages are owner-only
  (401 anonymous, 403 contractor); unknown workspaces in a scope are refused.
- **tools/list**: the seven tools, descriptions, read-only annotations, "never as instructions".
- **search_conversations**: keyword mode finds `pelican roof tiles` in exactly one recording with the
  snippet at 42 s and the deep link to it; hybrid mode fuses both rankers (unique recordings, ≤ 3
  snippets, descending scores, `semantic_coverage: full`); semantic mode ranks the recording that holds
  a distinctive passage first; `limit` above 50 is clamped; deleting one recording's chunks flips
  coverage to `partial` with a note and the recording is still found by keyword; workspace, party,
  date filters; an out-of-scope workspace returns nothing with a note.
- **get_interaction**: metadata, participants, projects, ±90 s default excerpt that is never the
  whole transcript; paging with `next_start_sec` until every segment of the longest recording has been
  seen in ≤ 10-minute windows; `not_found` for unknown and out-of-scope ids.
- **list_interactions**: newest first, participants, workspace/kind/date filters, default 20.
- **get_party**: by id, exact and partial name, email (case-insensitive), phone (digits, last ten),
  ambiguous names → candidates, orgs with affiliations, facts about/owned.
- **get_project**: by id and fuzzy name, candidates when several match, `not_found`.
- **list_open_commitments**: kinds, status, source moment and deep link, `due_before` and party
  filters, an empty result for a filter that matches nothing, and an empty result with the whole
  `facts` table empty.
- **scope**: a token scoped to `another_story` gets zero phalanx results from every tool in every
  search mode (keyword, semantic, hybrid), including fuzzy/email/id `get_party` lookups, projects,
  commitments and proposals; Ben's and Rachel's cross-workspace profiles show only the scoped side;
  `*` excludes phalanx until listed; an empty scope sees nothing.
- **propose_update**: a valid proposal lands in `review_queue` as `open` with `source: mcp` and shows
  on the Review page, and the row count of every other table is unchanged; invalid shapes are rejected
  with zod issues and write nothing; the `mcp_proposer` role cannot SELECT, UPDATE or DELETE anything
  and `mcp_reader` cannot write or read the token tables.
- **audit + rate limit**: every call logged with token, tool, redacted args (long query truncated),
  scope, result count, duration and error; the audit and status endpoints; the 61st call in a minute
  is refused for one token only.
- **OAuth 2.1**: discovery documents; dynamic registration (public client); `/authorize` → consent
  with PKCE; the consent page shows the password login when signed out, rejects a wrong password,
  shows the workspace picker with phalanx unticked; deny → `access_denied`; wrong CSRF → 403; approve
  → code (stored hashed) + state; token exchange rejects a wrong verifier and a reused code; tokens
  are stored hashed with the consented scope; the access token works on `/mcp` with exactly that
  scope; refresh rotates, a replayed refresh token is refused and revokes the whole grant; expired
  access tokens are refused; the connected-apps page shows the client and revoking it kills every
  token; a revoked client cannot authorize again; unregistered redirect URIs and tampered consent
  requests are refused.
- **embedding pipeline**: re-running a recording rebuilds identical chunks in one transaction; the
  worker's `embed` step embeds pending recordings (`EMBED_MAX_PER_RUN` per run, resumable), a provider
  outage leaves `embed_error` + attempts without touching `pipeline_status` or the old chunks, the next
  healthy run recovers, exhausted attempts wait for `--retry-failed`; the Pipeline page shows the counts.

## Backfill dry run on the seed

```
$ EMBEDDING_PROVIDER=fake npm run embed:backfill -- --dry-run
[embed:backfill] database 127.0.0.1:54329 · provider fake fake-hash-1024 (1024 dims, $0/M tokens) · DRY RUN, nothing will be written
[embed:backfill] 37 recording(s) to embed; 0 already embedded and skipped

  recordings      37
  segments        4027
  chunks          825
  tokens (est.)   75,687  (~4 chars per token; includes the ~15% overlap and speaker labels)
  cost (est.)     $0.00 at $0 per million tokens on fake fake-hash-1024

  by workspace:
    strout_arch             10 recordings     227 chunks       22,007 tokens
    credvault                5 recordings     155 chunks       13,893 tokens
    another_story            7 recordings     117 chunks       10,693 tokens
    southern_shutter         7 recordings     114 chunks       10,394 tokens
    phalanx                  4 recordings     108 chunks        9,417 tokens
    sepp                     4 recordings     104 chunks        9,283 tokens
```

The same script against production (1,189 interactions, ~397k segments, ~6M transcript tokens) is for Ben to
run: with ~15% overlap and the speaker labels the embedded volume comes to roughly 7M tokens, about
**$0.45 on voyage-3.5** ($0.06 per million; a new Voyage account includes 200M free tokens) or about $0.14 on
`text-embedding-3-small`. The real number prints at the top of the `--dry-run` output.
