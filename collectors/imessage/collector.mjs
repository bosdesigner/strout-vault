#!/usr/bin/env node
// Strout Vault iMessage/SMS collector. Runs on Ben's Mac every 15 minutes (launchd), reads
// ~/Library/Messages/chat.db read-only from a temp copy, and POSTs new messages to
// <STROUT_VAULT_URL>/api/ingest/messages with an ingest:messages token. The server filters,
// redacts, matches and routes again; nothing the collector skips is ever sent.
//
//   node collector.mjs                 send everything after the last ROWID sent
//   node collector.mjs --dry-run       print what would be sent (counts per conversation), send nothing
//   node collector.mjs --db <path>     read another chat.db (a fixture)
//   node collector.mjs --state <path>  where the last ROWID is kept (default ~/.strout-vault/imessage-state.json)
//   node collector.mjs --from-start    ignore the state file (with --dry-run: preview the whole history)
//
// Env: STROUT_VAULT_URL (https://<app>), STROUT_VAULT_TOKEN or ~/.strout-vault/imessage-token.
// Output is counts only. Message text is never printed or written anywhere on the Mac.
import fs from "node:fs";
import os from "node:os";
import { closeCopy, defaultPaths, openChatDbCopy, readMessages, readState, writeState } from "./lib.mjs";

const VERSION = "1.0.0";
// The vault files a conversation's texts per day in this zone; the dry run counts days the same way.
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const READ_PAGE = 1000;
const POST_BATCH = 500;

function parseArgs(argv) {
  const d = defaultPaths();
  const out = { dryRun: false, db: d.chatDb, state: d.state, tokenFile: d.token, fromStart: false, url: process.env.STROUT_VAULT_URL ?? "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--db") out.db = argv[++i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--token-file") out.tokenFile = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--from-start") out.fromStart = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function readToken(file) {
  if (process.env.STROUT_VAULT_TOKEN) return process.env.STROUT_VAULT_TOKEN.trim();
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

async function post(url, token, messages, counts) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/ingest/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ collector: { name: "imessage", version: VERSION, host: os.hostname() }, collector_counts: counts, messages }),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`POST /api/ingest/messages answered ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = readToken(args.tokenFile);
  if (!args.dryRun) {
    if (!args.url) throw new Error("STROUT_VAULT_URL is not set");
    if (!token) throw new Error(`no token: set STROUT_VAULT_TOKEN or write it to ${args.tokenFile}`);
  }
  if (!fs.existsSync(args.db)) throw new Error(`${args.db} not found (or Full Disk Access is missing for this node binary: see README)`);

  const state = args.fromStart ? { lastRowId: 0 } : readState(args.state);
  const copy = openChatDbCopy(args.db);
  const perChat = new Map();
  const skipped = {};
  let sent = 0;
  let cursor = state.lastRowId;
  try {
    let pending = [];
    let pendingMax = cursor;
    let pendingSkips = {};
    const flush = async () => {
      if (!args.dryRun && (pending.length || pendingMax > cursor)) {
        if (pending.length) {
          const r = await post(args.url, token, pending, pendingSkips);
          console.log(`[imessage] sent ${pending.length} message(s): ${r.created} new thread(s), ${r.updated} updated, ${r.unchanged} unchanged`);
        }
        writeState(args.state, pendingMax);
      }
      sent += pending.length;
      cursor = pendingMax;
      pending = [];
      pendingSkips = {};
    };
    for (;;) {
      const rows = readMessages(copy.db, pendingMax, READ_PAGE);
      if (!rows.length) break;
      for (const r of rows) {
        pendingMax = Math.max(pendingMax, r.rowid);
        if (r.skip) {
          skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
          pendingSkips[r.skip] = (pendingSkips[r.skip] ?? 0) + 1;
          continue;
        }
        const c = perChat.get(r.chatLabel) ?? { messages: 0, fromMe: 0, attachments: 0, days: new Set() };
        c.messages++;
        if (r.message.is_from_me) c.fromMe++;
        c.attachments += r.message.attachments.length;
        c.days.add(dayFmt.format(new Date(r.message.sent_at)));
        perChat.set(r.chatLabel, c);
        pending.push(r.message);
        if (pending.length >= POST_BATCH) await flush();
      }
    }
    await flush();
  } finally {
    closeCopy(copy);
  }

  if (args.dryRun) {
    console.log(`[imessage] DRY RUN: nothing was sent and the state file was not touched`);
    console.log(`[imessage] would send ${sent} message(s) from ${perChat.size} conversation(s), ROWID ${state.lastRowId + 1}..${cursor}`);
    const rows = [...perChat.entries()].sort((a, b) => b[1].messages - a[1].messages);
    console.log(`  ${"conversation".padEnd(34)} ${"messages".padStart(8)} ${"from me".padStart(8)} ${"days".padStart(5)} ${"attach".padStart(6)}`);
    for (const [label, c] of rows) console.log(`  ${String(label).slice(0, 34).padEnd(34)} ${String(c.messages).padStart(8)} ${String(c.fromMe).padStart(8)} ${String(c.days.size).padStart(5)} ${String(c.attachments).padStart(6)}`);
  } else {
    console.log(`[imessage] done: ${sent} message(s) sent from ${perChat.size} conversation(s); last ROWID ${cursor}`);
  }
  console.log(`[imessage] skipped on the Mac: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing"}`);
}

main().catch((err) => {
  console.error(`[imessage] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
