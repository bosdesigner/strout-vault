// npx tsx scripts/build-synthetic-chatdb.ts <path/to/chat.db>
//
// Writes the synthetic chat.db the tests use (tests/fixtures/imessage/chatdb.ts): made-up
// conversations with 555 numbers, one body stored only in attributedBody, a short code, a
// one-time code, a tapback and a group event. For trying the collector without real messages:
//   node collectors/imessage/collector.mjs --dry-run --from-start --db <path> --state /tmp/state.json
import path from "node:path";
import { buildChatDb, FIXTURE_MESSAGES } from "../tests/fixtures/imessage/chatdb.ts";

const out = path.resolve(process.argv[2] ?? "synthetic-chat.db");
buildChatDb(out);
console.log(`wrote ${out} (${FIXTURE_MESSAGES.length} synthetic messages)`);
