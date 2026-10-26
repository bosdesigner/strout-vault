#!/usr/bin/env bash
# MCP Inspector transcripts for texts: search_conversations finding a fixture text thread with an
# Another Story token, and NOT finding the fixture phalanx thread (filed to inbox) with that same
# token, which a token that names inbox does find. Writes docs/messages-verification/inspector-transcripts.md.
#
#   BASE=http://localhost:3000 STORY_TOKEN=svt_... FULL_TOKEN=svt_... PHALANX_ID=<id> scripts/messages-inspector-transcripts.sh
#
# Run against a local vault with the synthetic chat.db imported (docs/messages-verification/README.md).
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
: "${STORY_TOKEN:?an Another Story token (workspace scope [\"another_story\"])}"
: "${FULL_TOKEN:?a token that names phalanx, personal and inbox}"
: "${PHALANX_ID:?the interaction id of the fixture phalanx thread}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/messages-verification/inspector-transcripts.md"
INSPECT=(npx --yes @modelcontextprotocol/inspector@2.12.0 --cli "$BASE/mcp" --transport http)

{
  echo "# MCP Inspector transcripts: texts"
  echo
  echo "Run on $(date -u +%Y-%m-%d) with the official MCP Inspector (\`@modelcontextprotocol/inspector\` 2.12.0, CLI mode) against"
  echo "a local vault holding the seed data plus the synthetic chat.db, sent by the collector itself. The fake embedding"
  echo "provider is on, so hybrid search runs. Tokens are redacted. \"Another Story token\" has workspace scope"
  echo "\`[\"another_story\"]\`; \"full token\" has \`[\"*\", \"phalanx\", \"personal\", \"inbox\"]\`."
  echo
} > "$OUT"

run() { # title, token-label, token, args...
  local title="$1" label="$2" token="$3"; shift 3
  {
    echo "## $title"
    echo
    echo '```'
    echo "\$ npx @modelcontextprotocol/inspector --cli $BASE/mcp --transport http --header \"Authorization: Bearer <$label>\" $*"
    "${INSPECT[@]}" --header "Authorization: Bearer $token" "$@" 2>&1 | sed "s/$token/<$label>/g" || true
    echo '```'
    echo
  } >> "$OUT"
}

run "Another Story token: search_conversations finds Kevin's texts about Conroe" "another-story-token" "$STORY_TOKEN" \
  --method tools/call --tool-name search_conversations --tool-arg 'query=Conroe shoot' --tool-arg kind=text_thread --tool-arg limit=3
run "Another Story token: keyword search for the phalanx thread's words finds nothing" "another-story-token" "$STORY_TOKEN" \
  --method tools/call --tool-name search_conversations --tool-arg 'query=term sheet redlines data room' --tool-arg mode=keyword --tool-arg limit=5
run "Another Story token: hybrid search over texts for the same words (nearest neighbours only, all another_story; no inbox/phalanx thread)" "another-story-token" "$STORY_TOKEN" \
  --method tools/call --tool-name search_conversations --tool-arg 'query=term sheet redlines data room' --tool-arg kind=text_thread --tool-arg limit=5
run "Another Story token: get_interaction on the phalanx thread is not found" "another-story-token" "$STORY_TOKEN" \
  --method tools/call --tool-name get_interaction --tool-arg "id=$PHALANX_ID"
run "Another Story token: list_interactions kind=text_thread (only another_story threads)" "another-story-token" "$STORY_TOKEN" \
  --method tools/call --tool-name list_interactions --tool-arg kind=text_thread
run "Full token: the same keyword search finds the phalanx thread, filed under inbox" "full-token" "$FULL_TOKEN" \
  --method tools/call --tool-name search_conversations --tool-arg 'query=term sheet redlines data room' --tool-arg mode=keyword --tool-arg limit=5
echo "wrote $OUT"
