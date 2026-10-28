#!/usr/bin/env node
// Strout Vault TikTok DM collector. Runs on Ben's Mac every 30 minutes (launchd): opens the TikTok
// inbox in its own Chrome profile (signed in once, by hand), opens each conversation whose list row
// changed since the last run, reads the messages on screen, and POSTs the new ones to
// <STROUT_VAULT_URL>/api/ingest/social with an ingest:messages token (kind: TikTok DM collector).
// The server filters, redacts, matches people by handle and routes, as it does for texts.
//
// It only reads. It never types, sends, likes, accepts or deletes anything. Opening a conversation
// in TikTok's web inbox marks it read there (and on the phone); that is the one side effect.
//
//   node collector.mjs --login              open a visible window and wait for you to sign in to TikTok
//   node collector.mjs --dry-run            read and print counts per conversation, send nothing, keep no state
//   node collector.mjs --probe              print what each selector matches on the live inbox (no message text)
//   node collector.mjs                      the scheduled run
//   node collector.mjs --all                open every conversation in the list, not only changed ones
//   node collector.mjs --max 80             open at most 80 conversations this run (default 40)
//   node collector.mjs --headed             show the browser window (default: headless Chrome)
//
// Env: STROUT_VAULT_URL, TIKTOK_ACCOUNT (your username, e.g. hemakesbigmoves), STROUT_VAULT_TOKEN or
// ~/.strout-vault/tiktok-token, TIKTOK_HEADED=1, TIKTOK_INBOX_URL (default https://www.tiktok.com/messages).
// Output is counts only. Message text is never printed or written on the Mac; the state file keeps
// hashes of what was seen, never the text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConversation, conversationKey, defaultPaths, digest, listRowChanged, readState, rowState, writeState } from "./lib.mjs";
import { DEFAULT_SELECTORS, probePage, readConversation, readList } from "./page.mjs";

const VERSION = "1.0.0";
const RUN_BUDGET_MS = 12 * 60_000;
const HISTORY_SCROLLS = 10;

function parseArgs(argv) {
  const d = defaultPaths();
  const out = {
    dryRun: false,
    probe: false,
    login: false,
    all: false,
    headed: process.env.TIKTOK_HEADED === "1",
    max: 40,
    url: process.env.STROUT_VAULT_URL ?? "",
    account: (process.env.TIKTOK_ACCOUNT ?? "").replace(/^@/, "").toLowerCase(),
    inbox: process.env.TIKTOK_INBOX_URL ?? "https://www.tiktok.com/messages",
    ...d,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--probe") out.probe = true;
    else if (a === "--login") (out.login = true), (out.headed = true);
    else if (a === "--all") out.all = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--max") out.max = Number(argv[++i]);
    else if (a === "--account") out.account = String(argv[++i] ?? "").replace(/^@/, "").toLowerCase();
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.max) || out.max < 1) throw new Error("--max takes a positive whole number");
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

function loadSelectors(file) {
  try {
    const override = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...DEFAULT_SELECTORS, ...override };
  } catch {
    return DEFAULT_SELECTORS;
  }
}

const pause = (min = 800, max = 2500) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function post(args, token, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${args.url.replace(/\/$/, "")}/api/ingest/social`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`POST /api/ingest/social answered ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function launch(args) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed: run npm ci in collectors/tiktok");
  }
  fs.mkdirSync(args.profile, { recursive: true, mode: 0o700 });
  // Your real Google Chrome (channel "chrome"), in a profile of its own: never your everyday profile.
  return chromium.launchPersistentContext(args.profile, {
    channel: "chrome",
    headless: !args.headed,
    viewport: { width: 1360, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function signedIn(page, sel, waitMs) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (/\/login/.test(page.url())) return false;
    const rows = await page.locator(sel.listItem).count().catch(() => 0);
    if (rows > 0) return true;
    const login = await page.locator(sel.loginMarker).count().catch(() => 0);
    if (login > 0 && waitMs < 60_000) return false;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function noteFailure(args, page, sel, what) {
  try {
    fs.mkdirSync(args.failures, { recursive: true, mode: 0o700 });
    const report = await page.evaluate(probePage, sel);
    const file = path.join(args.failures, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ what, ...report }, null, 1), { mode: 0o600 });
    console.log(`[tiktok] ${what}; page structure (no text) saved to ${file}`);
  } catch {
    console.log(`[tiktok] ${what}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sel = loadSelectors(args.selectors);
  const token = readToken(args.token);
  if (!args.dryRun && !args.probe && !args.login) {
    if (!args.url) throw new Error("STROUT_VAULT_URL is not set");
    if (!token) throw new Error(`no token: set STROUT_VAULT_TOKEN or write it to ${args.token}`);
    if (!args.account) throw new Error("TIKTOK_ACCOUNT is not set (your TikTok username, e.g. hemakesbigmoves)");
  }
  const started = Date.now();
  const context = await launch(args);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(args.inbox, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (args.login) {
      console.log("[tiktok] sign in to TikTok in the window that opened (any method). Waiting up to 10 minutes…");
      if (!(await signedIn(page, sel, 10 * 60_000))) throw new Error("not signed in after 10 minutes");
      console.log("[tiktok] signed in; the session is kept in ~/.strout-vault/tiktok-profile. You can close this.");
      return;
    }

    if (!(await signedIn(page, sel, 25_000))) {
      await noteFailure(args, page, sel, "the inbox did not load: signed out, or the list selector no longer matches");
      if (!args.dryRun && !args.probe && args.url && token && args.account) {
        // An empty batch that says why, so the Sources panel can tell Ben to sign in again.
        await post(args, token, { platform: "tiktok", account: args.account, collector: { name: "tiktok", version: VERSION, host: os.hostname() }, collector_counts: { login_required: 1 }, conversations: [] }).catch(() => {});
      }
      throw new Error("TikTok inbox not available: run `node collector.mjs --login` (or --probe if you are signed in)");
    }

    if (args.probe) {
      const report = await page.evaluate(probePage, sel);
      const rows = await page.evaluate(readList, sel);
      console.log(`[tiktok] inbox ${report.url}: ${rows.length} conversation row(s), ${rows.filter((r) => r.unread).length} unread, ${rows.filter((r) => r.time_label).length} with a time`);
      console.log(`[tiktok] selector matches: ${JSON.stringify(report.counts)}`);
      console.log(`[tiktok] data-e2e on the page: ${report.dataE2e.join(", ")}`);
      if (rows.length) {
        await page.locator(sel.listItem).first().click();
        await pause(2000, 3000);
        const conv = await page.evaluate(readConversation, sel, args.account);
        const after = await page.evaluate(probePage, sel);
        console.log(`[tiktok] first conversation: username ${conv.username ? "found" : "NOT FOUND"}, ${conv.itemCount} item(s), ${conv.messages.length} message(s) (${conv.messages.filter((m) => m.from_me).length} yours, ${conv.messages.filter((m) => m.time_label).length} with a time label)`);
        console.log(`[tiktok] selector matches with a conversation open: ${JSON.stringify(after.counts)}`);
        fs.mkdirSync(args.failures, { recursive: true, mode: 0o700 });
        const file = path.join(args.failures, "probe.json");
        fs.writeFileSync(file, JSON.stringify(after, null, 1), { mode: 0o600 });
        console.log(`[tiktok] page structure (tags, classes, data-e2e; no text) saved to ${file}`);
      }
      return;
    }

    const state = readState(args.state);
    const now = new Date();
    const rows = await page.evaluate(readList, sel);
    const rowKey = (r) => digest(r.nickname ?? "", r.avatar ?? "");
    const todo = rows.filter((r) => args.all || listRowChanged(r, state.rows[rowKey(r)])).slice(0, args.max);
    const counts = { rows: rows.length, opened: 0, unchanged_rows: rows.length - todo.length, unreadable: 0, misaligned: 0 };
    const conversations = [];
    const nextConv = {};
    const nextRows = {};
    const report = [];

    for (const r of todo) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      try {
        // Find the row again by what it shows: the list can reorder while we read.
        const loc = page.locator(sel.listItem).filter({ hasText: r.nickname ?? "" }).first();
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click();
        await pause();
        let conv = await page.evaluate(readConversation, sel, args.account);
        for (let i = 0; i < 6 && !conv.username; i++) {
          await page.waitForTimeout(800);
          conv = await page.evaluate(readConversation, sel, args.account);
        }
        counts.opened++;
        if (!conv.username) {
          counts.unreadable++;
          await noteFailure(args, page, sel, `could not read the username of a conversation (row ${r.index + 1})`);
          continue;
        }
        const key = conversationKey(conv.username);
        if (!state.conversations[key]) {
          // First time this conversation is read: scroll up for older messages TikTok loads lazily.
          let before = conv.messages.length;
          for (let i = 0; i < HISTORY_SCROLLS; i++) {
            await page.evaluate((s) => {
              const box = document.querySelector(s.split(",")[0].trim()) ?? [...s.split(",")].map((x) => document.querySelector(x.trim())).find(Boolean);
              if (box) box.scrollTop = 0;
            }, sel.messageScroller);
            await pause(1200, 2200);
            conv = await page.evaluate(readConversation, sel, args.account);
            if (conv.messages.length <= before) break;
            before = conv.messages.length;
          }
        }
        const { entry, next, aligned } = buildConversation({ key, username: conv.username, nickname: conv.nickname ?? r.nickname, messages: conv.messages }, state.conversations[key], now);
        if (!aligned) counts.misaligned++;
        nextConv[key] = next;
        nextRows[rowKey(r)] = rowState(r, key, now);
        if (entry) conversations.push(entry);
        report.push({ who: `@${conv.username}`, onScreen: conv.messages.length, new: entry?.messages.length ?? 0, yours: entry?.messages.filter((m) => m.from_me).length ?? 0 });
      } catch (err) {
        counts.unreadable++;
        await noteFailure(args, page, sel, `row ${r.index + 1} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }

    const total = conversations.reduce((n, c) => n + c.messages.length, 0);
    if (args.dryRun) {
      console.log(`[tiktok] DRY RUN: nothing was sent and the state file was not touched`);
      console.log(`[tiktok] ${rows.length} conversation(s) in the list; opened ${counts.opened}; ${total} new message(s) in ${conversations.length} conversation(s)`);
      console.log(`  ${"conversation".padEnd(32)} ${"on screen".padStart(9)} ${"new".padStart(5)} ${"yours".padStart(6)}`);
      for (const r of report) console.log(`  ${r.who.slice(0, 32).padEnd(32)} ${String(r.onScreen).padStart(9)} ${String(r.new).padStart(5)} ${String(r.yours).padStart(6)}`);
      if (counts.unreadable) console.log(`[tiktok] ${counts.unreadable} conversation(s) could not be read: see ${args.failures}`);
      return;
    }

    // Send first, then remember: a failed POST leaves the state as it was, so the next run resends.
    const body = { platform: "tiktok", account: args.account, collector: { name: "tiktok", version: VERSION, host: os.hostname() }, collector_counts: counts, conversations };
    if (conversations.length || counts.unreadable) {
      const r = await post(args, token, body);
      console.log(`[tiktok] sent ${total} message(s) from ${conversations.length} conversation(s): ${r.created} new thread(s), ${r.updated} updated, ${r.unchanged} unchanged, ${r.review_new_party} unknown account(s) queued`);
    } else {
      await post(args, token, body);
      console.log(`[tiktok] nothing new (${rows.length} conversation(s) in the list)`);
    }
    state.conversations = { ...state.conversations, ...nextConv };
    state.rows = { ...state.rows, ...nextRows };
    state.last_run = now.toISOString();
    writeState(args.state, state);
    if (counts.misaligned) console.log(`[tiktok] ${counts.misaligned} conversation(s) did not line up with what was seen before; only messages never seen were sent`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[tiktok] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
