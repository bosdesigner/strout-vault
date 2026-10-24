#!/usr/bin/env bash
# Calls every MCP tool through the official MCP Inspector (CLI mode) against a running vault
# and writes the transcripts to docs/mcp-verification/inspector-transcripts.md plus the raw
# JSON tool results to docs/mcp-verification/sample-responses.md.
#
#   BASE=http://localhost:3000 TOKEN=svt_... STORY_TOKEN=svt_... scripts/mcp-inspector-transcripts.sh
#
# TOKEN should see every workspace (["*", "phalanx"]); STORY_TOKEN only another_story, to show
# the scope refusing a phalanx recording. Run `npm run dev` (or the built server) first.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
: "${TOKEN:?set TOKEN to a personal access token}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/mcp-verification"
mkdir -p "$OUT_DIR"
T="$OUT_DIR/inspector-transcripts.md"
S="$OUT_DIR/sample-responses.md"
INSPECT=(npx --yes @modelcontextprotocol/inspector@2.12.0 --cli "$BASE/mcp" --transport http)

{
  echo "# MCP Inspector transcripts"
  echo
  echo "Every tool called through the official MCP Inspector (\`@modelcontextprotocol/inspector\` 2.12.0, CLI mode) against the"
  echo "vault running locally on $(date -u +%Y-%m-%d) with the seeded database and the fake embedding provider. Tokens are"
  echo "redacted. Each block shows the exact command and the Inspector's output."
  echo
} > "$T"
{
  echo "# Sample tool responses"
  echo
  echo "The JSON each tool returned in the Inspector run of $(date -u +%Y-%m-%d) (\`inspector-transcripts.md\`), pretty-printed."
  echo "Deep links point at the local server; in production they carry PUBLIC_URL."
  echo
} > "$S"

run() { # title, token, args...
  local title="$1" token="$2"; shift 2
  local shown="${*//$token/<token>}"
  echo "## $title" >> "$T"
  echo >> "$T"
  echo '```' >> "$T"
  echo "$ npx @modelcontextprotocol/inspector --cli $BASE/mcp --transport http --header \"Authorization: Bearer <token>\" $shown" >> "$T"
  local out
  out="$("${INSPECT[@]}" --header "Authorization: Bearer $token" "$@" 2>&1 || true)"
  echo "$out" | sed "s/$token/<token>/g" >> "$T"
  echo '```' >> "$T"
  echo >> "$T"
  # The tool result text is JSON inside content[0].text; pretty-print it for the samples file.
  # (For isError results the Inspector appends its own {"error":…} line after the JSON; only the first object counts.)
  if echo "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const first=s.split(/\n(?=\{"error")/)[0];const j=JSON.parse(first);const t=j.content?.[0]?.text;if(!t)process.exit(1);console.log(JSON.stringify(JSON.parse(t),null,2))}catch{process.exit(1)}})' > /tmp/mcp-sample.json 2>/dev/null; then
    echo "## $title" >> "$S"
    echo >> "$S"
    echo '```json' >> "$S"
    sed "s/$token/<token>/g" /tmp/mcp-sample.json >> "$S"
    echo '```' >> "$S"
    echo >> "$S"
  fi
}

run "tools/list" "$TOKEN" --method tools/list
run "search_conversations (hybrid)" "$TOKEN" --method tools/call --tool-name search_conversations --tool-arg 'query=copper gutters' --tool-arg limit=3
run "search_conversations (semantic, distinctive passage)" "$TOKEN" --method tools/call --tool-name search_conversations --tool-arg 'query=board observer seat' --tool-arg mode=semantic --tool-arg limit=2
run "search_conversations (keyword, phrase)" "$TOKEN" --method tools/call --tool-name search_conversations --tool-arg 'query="pelican roof tiles"' --tool-arg mode=keyword
run "list_interactions" "$TOKEN" --method tools/call --tool-name list_interactions --tool-arg workspace=strout_arch --tool-arg limit=3
run "get_interaction (excerpt around 42 s)" "$TOKEN" --method tools/call --tool-name get_interaction --tool-arg id=38 --tool-arg start_sec=42 --tool-arg window_sec=40
run "get_party (fuzzy name)" "$TOKEN" --method tools/call --tool-name get_party --tool-arg name=McGuire
run "get_party (ambiguous name)" "$TOKEN" --method tools/call --tool-name get_party --tool-arg name=ben
run "get_project (fuzzy name)" "$TOKEN" --method tools/call --tool-name get_project --tool-arg name=bungalow
run "list_open_commitments" "$TOKEN" --method tools/call --tool-name list_open_commitments --tool-arg limit=3
run "propose_update (valid new_fact)" "$TOKEN" --method tools/call --tool-name propose_update --tool-arg item_type=new_fact --tool-arg 'proposal={"interaction_id":38,"kind":"decision","text":"Pelican roof tiles chosen for the pool house.","quote_start_sec":42}' --tool-arg 'reason=Said at 0:42 of the tile walkthrough.' --tool-arg interaction_id=38
run "propose_update (invalid proposal, rejected)" "$TOKEN" --method tools/call --tool-name propose_update --tool-arg item_type=new_fact --tool-arg 'proposal={"kind":"wish"}' --tool-arg reason=x
if [ -n "${STORY_TOKEN:-}" ]; then
  run "scope: another_story token asks for a phalanx recording" "$STORY_TOKEN" --method tools/call --tool-name search_conversations --tool-arg 'query=cap the pilot at one site ninety days security committee' --tool-arg limit=3
  run "scope: another_story token looks up a phalanx-only person" "$STORY_TOKEN" --method tools/call --tool-name get_party --tool-arg 'name=Daniel Okafor'
fi
echo "wrote $T and $S"
