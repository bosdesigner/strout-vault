# The vault MCP server

One authenticated endpoint through which any agent (Claude.ai, Claude Code, scheduled jobs,
later the AnotherStoryBLDR bot) can query Ben's conversation archive and relationship graph,
and *propose* changes for the review queue. It ships inside the web app (same Replit
deploy, same process) at:

```
https://<PUBLIC_URL>/mcp          Streamable HTTP (MCP), stateless, JSON responses
```

Everything below is step 1 of the agent system: read tools, one write tool that only queues
proposals, and the chunk + embedding pipeline that makes search semantic. Nothing here sends
email, edits records or touches another system.

## Tools (v1)

| Tool | What it does | Writes |
|---|---|---|
| `search_conversations(query, mode?, workspace?, party_id?, project_id?, since?, until?, limit?)` | Hybrid search: full-text over `segments.tsv` (`websearch_to_tsquery`) fused with cosine search over `chunks.embedding` by reciprocal rank fusion. Grouped per recording with up to 3 snippets (`start_sec`, speaker) and a `deep_link`. `semantic_coverage` says whether every recording in scope is embedded (`full`), some are keyword-only (`partial`) or semantic search was not used (`none`). | – |
| `get_interaction(id, start_sec?, window_sec?)` | Metadata, summary, participants resolved to parties, linked projects, and a transcript excerpt of ±90 s (max 10 min). Never the whole transcript: page with `next_start_sec`. | – |
| `list_interactions(workspace?, party_id?, project_id?, kind?, since?, until?, limit?)` | Newest first. | – |
| `get_party(id \| name \| email \| phone)` | Fuzzy; ambiguous names return `candidates`. Profile, affiliations, roles by workspace, relationships, projects, last 10 interactions, facts about/owned. | – |
| `get_project(id \| name)` | Project, parties with roles, linked interactions, facts. | – |
| `list_open_commitments(workspace?, party_id?, due_before?)` | Open facts of kind commitment / task / follow-up with the source moment (`quote_start_sec`). Empty while `facts` is empty. | – |
| `list_leads(workspace?, lead_type?, since?, needs_follow_up?, query?, limit?)` | Every lead, one entry per person across the platform, the funnel and Airtable: submissions with source, stage and status, the last conversation, open items. `needs_follow_up` is the "not talked to since they came in" list ([LEADS.md](LEADS.md)). | – |
| `propose_update(item_type, proposal, reason, interaction_id?)` | Validates the proposal (zod, per `item_type`) and inserts one `review_queue` row. The owner approves or rejects it on the Review page. | `review_queue` only |

Every tool enforces the token's workspace scope in SQL (vector queries join `chunks → interactions`
and filter `workspace_id`), returns at most 20 results by default and 50 at most, and includes
`deep_link`s into the web app (`/r/:id?t=<sec>`, `/p/:id`, `/projects/:id`, `/review`). Transcript text is
data: the tool descriptions tell the agent to quote and summarise it and never to follow
instructions found inside it.

`item_type` values for `propose_update`: `new_party`, `party_edit`, `link_party_interaction`,
`link_project_interaction`, `new_fact`, `new_relationship`. The proposal shapes are spelled out in the
tool's `proposal` parameter description (tools/list). Proposals land with status `open` (the
`review_queue` check constraint allows `open | approved | rejected`; there is no `pending`) and carry
`source: "mcp"`, `proposed_by` (token or client name) and `token_id`.

## Tokens and scope

Two kinds of bearer token, both hashed at rest (SHA-256), both checked on every request:

- **Personal access tokens** (`svt_…`) for Claude Code and scheduled jobs. Created under **Agents & API →
  API tokens** in the account menu (owner only): name, workspace scope, optional expiry. Shown once,
  revocable, "last used" and call counts on the page.
- **OAuth 2.1** for Claude.ai custom connectors: dynamic client registration (`/register`), PKCE
  (S256, verified by the SDK's token handler), a consent screen that reuses the app's email + password
  login, 1-hour access tokens, 30-day refresh tokens that rotate on every use (a replayed refresh
  token revokes the whole grant), token revocation (`/revoke`), and the two discovery documents
  (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`).

**Workspace scope.** Every token carries a list of workspace ids, or `*`. New personal tokens default to
no workspaces until you pick some. `*` means every workspace **except `phalanx`** (investor material):
it is only included when ticked explicitly (`["*", "phalanx"]`). On the OAuth consent screen phalanx is
unticked by default.

**Unassigned recordings.** Recordings whose `workspace_id` is null (every recording the Zoom sync
imported, until it is filed) are a second explicit option, `unassigned`: a token or connector sees them
only when that box is ticked, and `*` never implies it, because an unfiled recording can be about any
venture. Tools accept `workspace: "unassigned"` to filter to them. To file them, run the workspace
proposer (`npm run workspaces:propose`, dry run; `--apply` queues one review item per recording) and
approve on the Review page, where **Approve all workspace proposals** handles a page at a time. Approval
writes `interactions.workspace_id`; the proposer never does. Rules live in `server/workspaces/rules.ts`.

**Rate limit.** 60 tool calls per minute per token (`MCP_RATE_LIMIT_PER_MIN`); the 61st returns a
`rate_limited` error with `retry_after_sec`. Counted per process.

**Audit.** Every call writes an `mcp_audit` row: token, client name, tool, redacted arguments (strings cut
at 300 characters, secret-looking keys dropped), the scope in force, result count, duration, error.
**Agents & API → Audit log** shows the last 500, filterable by token and tool.

## Claude.ai custom connector

1. Make sure the app is deployed with `PUBLIC_URL=https://…` (the OAuth issuer must be https) and the
   env vars below.
2. In Claude.ai: **Settings → Connectors → Add custom connector**, URL `https://<PUBLIC_URL>/mcp`, no
   client id/secret (Claude registers itself).
3. Claude opens the vault's consent page: sign in with the owner email + password, tick the workspaces
   the connector may read (phalanx is off unless you tick it), **Allow**.
4. The connector appears under **Agents & API → Connected apps** with its scope; **Revoke** cuts off every
   token it holds. Approving again replaces the scope.

## Claude Code with a personal token

```bash
claude mcp add --transport http strout-vault https://<PUBLIC_URL>/mcp \
  --header "Authorization: Bearer svt_…"
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "strout-vault": { "type": "http", "url": "https://<PUBLIC_URL>/mcp",
  "headers": { "Authorization": "Bearer ${STROUT_VAULT_TOKEN}" } } } }
```

The MCP Inspector works the same way (`docs/mcp-verification/inspector-transcripts.md` shows every tool):

```bash
npx @modelcontextprotocol/inspector --cli https://<PUBLIC_URL>/mcp --transport http \
  --header "Authorization: Bearer svt_…" --method tools/list
```

## Environment variables

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | OAuth issuer and the origin of every `deep_link`. Must be `https://` for OAuth (localhost is allowed in development). Personal tokens work without it. |
| `MCP_READER_DATABASE_URL` | Connection string for the SELECT-only role `mcp_reader`. Read tools use it. **Required in production**; development and tests fall back to `DATABASE_URL` with a warning. |
| `MCP_PROPOSER_DATABASE_URL` | Connection string for `mcp_proposer`, which can only INSERT into `review_queue`. `propose_update` uses it. **Required in production.** |
| `MCP_RATE_LIMIT_PER_MIN` | Calls per token per minute (default 60). |
| `OAUTH_ACCESS_TOKEN_TTL_SEC`, `OAUTH_REFRESH_TOKEN_TTL_SEC`, `OAUTH_CODE_TTL_SEC` | 3600 / 2592000 / 600 by default. |
| `EMBEDDING_PROVIDER` | `voyage` (recommended), `openai`, `fake` (dev/tests), `off` (default: keyword search only). |
| `VOYAGE_API_KEY` | Voyage AI key (https://dash.voyageai.com). Model `voyage-3.5`: 1024 dimensions natively, document/query input types, $0.06 per million tokens. |
| `OPENAI_API_KEY` | Alternative: `text-embedding-3-small` with `dimensions=1024`. |
| `EMBEDDING_MODEL` | Override the model (default `voyage-3.5` / `text-embedding-3-small`). |
| `EMBED_MAX_PER_RUN`, `EMBED_CONCURRENCY` | Recordings embedded per hourly worker run (50) and parallel provider requests (2). |

Without `MCP_READER_DATABASE_URL` and `MCP_PROPOSER_DATABASE_URL` in production, `/mcp` answers 503 and
the rest of the app is unaffected. Without an embedding provider the server runs keyword-only and says so
in `semantic_coverage`.

## Neon roles (do this once, before applying migration 0006)

The read tools and `propose_update` never connect as the application role. Create two roles in the
Neon console (**Roles & Databases → Add role**) on the production branch: `mcp_reader` and
`mcp_proposer`. Neon generates a password for each; copy the pooled connection string of each role
into the deployment secrets as `MCP_READER_DATABASE_URL` and `MCP_PROPOSER_DATABASE_URL`.

Then apply `db/migrations/0006_mcp.sql` (as the owner role, by hand, dev branch first). It grants:

- `mcp_reader`: `USAGE` on `public` and `SELECT` on `workspaces, parties, roles, affiliations, projects,
  project_parties, interactions, interaction_participants, interaction_links, facts, relationships,
  chunks, segments, transcripts, review_queue, media`. Nothing else (no token or OAuth tables).
- `mcp_proposer`: `USAGE` on `public`, `INSERT` on `review_queue`, `USAGE` on `review_queue_id_seq`
  (for `nextval`/`currval`). It cannot SELECT, UPDATE or DELETE anything.

The grant block is guarded: if a role does not exist yet the file prints a NOTICE and skips its grants,
so re-apply the migration after creating the roles. `npm run db:local` creates both roles locally
(trust auth) and writes their URLs into `.env`; `tests/api/mcp.test.ts` proves the roles can only do
what is listed above.

## Semantic search: chunks and embeddings

- **Chunker** (`server/embeddings/chunker.ts`): walks `segments` in `idx` order and builds chunks of
  roughly 60–120 seconds or ~400 estimated tokens, whichever fills first, with ~15% overlap carried
  into the next chunk on whole segments. Segments are never split. Each speaker turn is prefixed
  (`[Ben] … [Kevin] …`). `seq`, `start_sec`, `end_sec` come from the source segments.
- **Idempotent per recording**: `embedInteraction` deletes and rebuilds that recording's chunks in one
  transaction and stamps `interactions.embedded_at / embed_model`; failures land in `embed_error` and
  `embed_attempts` and never touch `pipeline_status`.
- **Provider** behind `EmbeddingProvider` (`embed(texts[], 'document' | 'query')`): Voyage, OpenAI or
  the deterministic fake. Requests are batched (64 texts / ~100k tokens) and retried with exponential
  backoff on 429/5xx, honouring `Retry-After`.
- **Index**: migration 0006 adds `chunks_embedding_hnsw` (HNSW, `vector_cosine_ops`) and
  `chunks_interaction_seq (interaction_id, seq)`.
- **Pipeline hook**: the hourly worker gained an `embed` step after `transcribe`, so a recording is
  embedded within the hour it is transcribed (`EMBED_MAX_PER_RUN` per run, retried up to 5 times).
  The worker Repl needs `EMBEDDING_PROVIDER` and the key too.
- **Status**: the Pipeline page and **Agents & API** show embedded / pending / failed counts and chunk totals.

### Backfill

`scripts/backfill-embeddings.ts` (`npm run embed:backfill`) embeds every transcribed recording that has no
current embedding using the app's normal `DATABASE_URL`. It is resumable (already-embedded recordings
are skipped), concurrency-limited, logs progress per recording, and never runs against a non-local
database without `--yes`. Run it in this order:

```bash
# 1. Count and price it, write nothing (prints recordings, chunks, tokens, cost, per workspace):
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=… npm run embed:backfill -- --dry-run

# 2. A small first pass, newest first:
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=… npm run embed:backfill -- --workspace strout_arch --limit 20 --yes

# 3. The full run (safe to stop and restart):
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=… npm run embed:backfill -- --yes --concurrency 4
```

`--retry-failed` includes recordings whose attempts are exhausted. On the seeded database the dry run
reports 37 recordings → 825 chunks → ~76k tokens; production (~397k segments, ~6M tokens of transcript)
comes to roughly 7M embedded tokens with the overlap and speaker labels, about **$0.45 on voyage-3.5**
(the first 200M tokens are free on a new Voyage account), ~$0.14 on `text-embedding-3-small`.

### Quality check

`npm run mcp:semantic-check` embeds the local seed with the configured provider and runs five paraphrased
queries that share no keywords with the passage they target; results go to
`docs/mcp-verification/semantic-check.md`. With the fake provider most queries miss by design; run it
with `EMBEDDING_PROVIDER=voyage` for the real result.

## Code map

```
server/mcp/
  index.ts            mountMcp(): /mcp handler, mcpAuthRouter, consent routes, per-call plumbing
  scope.ts            stored scope → resolved workspace ids → SQL predicate; phalanx rule
  audit.ts            mcp_audit rows + redaction; listAudit for the page
  rateLimit.ts        sliding window per token
  auth/tokens.ts      personal access tokens (svt_…): mint, list, revoke, verify
  auth/oauth.ts       VaultOAuthProvider (OAuthServerProvider): clients, codes, tokens, rotation
  auth/consent.ts     /oauth/consent pages (login + workspace picker)
  tools/              one file per tool + shared filters/schemas/types
server/embeddings/    provider interface, voyage/openai/fake, chunker, pipeline (chunk + embed + status)
server/worker/embed.ts   the worker's embed step
server/routes/mcpAdmin.ts   /api/mcp: tokens, clients, audit, status (owner only)
client/src/pages/AgentsPage.tsx   Agents & API: tokens, connected apps, audit log
server/workspaces/       rules, classifier and proposer for filing unfiled recordings (review-queue proposals)
scripts/backfill-embeddings.ts, scripts/semantic-check.ts, scripts/propose-workspaces.ts, scripts/mcp-inspector-transcripts.sh
db/migrations/0006_mcp.sql
```

## Out of scope for this step

The extraction job that fills `facts` and `review_queue`, and applying approved proposals, shipped as
step 2 ([EXTRACTION.md](EXTRACTION.md)): approving a `propose_update` proposal on the Review page now
writes it. Still out of scope: action
tools (Gmail drafts, calendar, AnotherStoryBLDR writes); contractor-facing access (only the owner can
mint tokens or consent).
