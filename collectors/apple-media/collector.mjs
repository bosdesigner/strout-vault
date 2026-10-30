#!/usr/bin/env node
// Strout Vault Apple media collector. Runs on Ben's Mac every 10 minutes (launchd) and sends
// Voice Memos, iPhone call recordings (the Notes "Call Recordings" folder) and Apple Notes text to
// <STROUT_VAULT_URL>/api/ingest/device with an ingest:device token from the Keychain. It reads the
// iCloud-synced copies on the Mac, read-only: databases are copied to a temp dir and opened
// ?mode=ro, media files are only read. Nothing in an Apple container is changed, moved or deleted.
//
//   node collector.mjs                 send what is new since the last run (and edited notes)
//   node collector.mjs --dry-run       counts and total bytes per source; uploads nothing, state untouched
//   node collector.mjs --backfill      everything, not just what is newer than the first run (server dedupes)
//   node collector.mjs --since 2026-01-01   only items on or after that date (with or without --backfill)
//   node collector.mjs --discover      print the real paths, tables and columns on this Mac; read-only
//
// Other flags: --config <file> (default ~/.strout-vault/apple-media.json), --state <file>,
// --log-file <file> (default ~/Library/Logs/strout-vault-apple-media.log), --url <url>,
// --voice-memos <dir> / --notes <dir> (fixtures), --only voice_memo,iphone_call,apple_note.
// Env: STROUT_VAULT_URL, STROUT_VAULT_TOKEN (else the Keychain: service strout-vault, account apple-media).
// Output is counts and ids only: never a title, a transcript or a word of a note.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccessError,
  canRead,
  closeCopy,
  defaultPaths,
  discover,
  findVoiceMemosDir,
  fmtCounts,
  loadConfig,
  makeLogger,
  matchCallLog,
  openCopy,
  readCallHistory,
  readNotes,
  readState,
  readToken,
  readVoiceMemos,
  SchemaError,
  sha256File,
  writeState,
} from "./lib.mjs";

const VERSION = "1.0.0";
const SOURCES = ["voice_memo", "iphone_call", "apple_note"];
/** A normal run only looks this far behind the first run's start; --backfill looks at everything. */
const FIRST_RUN_LOOKBACK_DAYS = 2;

function parseArgs(argv) {
  const d = defaultPaths();
  const out = {
    dryRun: false,
    backfill: false,
    discover: false,
    since: null,
    config: d.config,
    state: d.state,
    logFile: d.log,
    url: process.env.STROUT_VAULT_URL ?? "",
    voiceMemosDirs: d.voiceMemosDirs,
    notesDir: d.notesDir,
    callHistory: d.callHistory,
    only: SOURCES,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--backfill") out.backfill = true;
    else if (a === "--discover") out.discover = true;
    else if (a === "--since") {
      const v = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("--since takes YYYY-MM-DD");
      out.since = new Date(`${v}T00:00:00`);
    } else if (a === "--config") out.config = argv[++i];
    else if (a === "--call-history") out.callHistory = argv[++i] === "-" ? null : argv[i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--log-file") out.logFile = argv[++i] === "-" ? null : argv[i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--voice-memos") out.voiceMemosDirs = [argv[++i]];
    else if (a === "--notes") out.notesDir = argv[++i];
    else if (a === "--only") {
      out.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const s of out.only) if (!SOURCES.includes(s)) throw new Error(`--only: unknown source ${s}`);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

class Vault {
  constructor(url, token, log) {
    this.base = url.replace(/\/$/, "");
    this.token = token;
    this.log = log;
  }

  async call(method, p, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.base}/api/ingest/device${p}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < 3) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        throw new Error(`${method} ${p}: ${err.message}`);
      }
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const text = await res.text().catch(() => "");
      let code = "";
      try {
        code = JSON.parse(text).error ?? "";
      } catch {
        /* not JSON */
      }
      const err = new Error(`${method} /api/ingest/device${p} answered ${res.status}${code ? ` (${code})` : ""}`);
      err.status = res.status;
      throw err;
    }
  }

  /** PUTs one byte range of `file` to a presigned part URL. */
  async putPart(url, headers, file, start, length) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "PUT",
          headers: { ...headers, "content-length": String(length) },
          body: fs.createReadStream(file, { start, end: start + length - 1 }),
          duplex: "half",
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`part upload answered ${res.status}`), { fatal: true });
      } catch (err) {
        if (err.fatal || attempt >= 3) throw err;
      }
      await sleep(2000 * 2 ** attempt);
    }
  }

  /** presign -> PUT every part -> finalize. Returns { duplicate, interaction_id }. */
  async sendFile(item) {
    const pre = await this.call("POST", "/presign", { source: item.source, source_ref: item.ref, sha256: item.sha256, bytes: item.bytes, content_type: item.contentType, filename: item.filename });
    if (pre.duplicate) return pre;
    for (const part of pre.parts) {
      const start = (part.part_number - 1) * pre.part_size;
      await this.putPart(part.url, part.headers ?? {}, item.file, start, Math.min(pre.part_size, item.bytes - start));
    }
    return this.call("POST", "/finalize", {
      source: item.source,
      source_ref: item.ref,
      sha256: item.sha256,
      bytes: item.bytes,
      key: pre.key,
      upload_id: pre.upload_id,
      content_type: item.contentType,
      filename: item.filename,
      occurred_at: item.occurredAt.toISOString(),
      duration_sec: item.durationSec,
      title: item.title,
      participants_raw: item.participants,
      source_payload: item.payload,
      run_id: item.runId,
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT_TYPES = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".qta": "audio/mp4", ".caf": "audio/x-caf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac" };

/** Everything this run could send, per source, with skip reasons. Opens each database from a temp copy. */
function collect(args, cfg) {
  const out = { voice_memo: [], iphone_call: [], apple_note: [], skipped: { voice_memo: {}, iphone_call: {}, apple_note: {} }, otherAudio: 0, found: {} };
  const bump = (src, why) => (out.skipped[src][why] = (out.skipped[src][why] ?? 0) + 1);
  if (args.only.includes("voice_memo") && cfg.include_voice_memos) {
    const dir = findVoiceMemosDir(args.voiceMemosDirs);
    out.found.voice_memo = !!dir;
    if (dir) {
      const copy = openCopy(path.join(dir, "CloudRecordings.db"));
      try {
        for (const m of readVoiceMemos(copy.db, dir, cfg)) {
          if (m.skip) bump("voice_memo", m.skip);
          else out.voice_memo.push({ source: "voice_memo", ref: `voice_memo:${m.uniqueId}`, file: m.file, bytes: m.bytes, filename: path.basename(m.file), contentType: CONTENT_TYPES[path.extname(m.file).toLowerCase()] ?? "audio/mp4", occurredAt: m.recordedAt ?? new Date(fs.statSync(m.file).mtime), durationSec: m.durationSec, title: m.title, participants: null, payload: { voice_memo_id: m.uniqueId }, when: m.recordedAt });
        }
      } finally {
        closeCopy(copy);
      }
    }
  }
  const wantCalls = args.only.includes("iphone_call") && cfg.include_call_recordings;
  const wantNotes = args.only.includes("apple_note") && cfg.include_notes;
  if (wantCalls || wantNotes) {
    const store = path.join(args.notesDir, "NoteStore.sqlite");
    out.found.notes = canRead(args.notesDir) && fs.existsSync(store);
    if (out.found.notes) {
      const copy = openCopy(store);
      try {
        const r = readNotes(copy.db, args.notesDir, cfg);
        out.otherAudio = r.otherAudio;
        out.duplicateCopies = r.duplicateCopies;
        if (wantCalls) {
          // "Call Recording" notes carry no contact: find the call in the Mac's call log by time.
          const unnamed = r.recordings.filter((c) => !c.skip && !c.participant);
          if (unnamed.length && args.callHistory && fs.existsSync(args.callHistory)) {
            try {
              const logCopy = openCopy(args.callHistory);
              try {
                const calls = readCallHistory(logCopy.db);
                for (const c of unnamed) {
                  const hit = matchCallLog(c, calls);
                  if (hit) {
                    c.participant = hit;
                    c.participantFrom = "call_history";
                  }
                }
              } finally {
                closeCopy(logCopy);
              }
            } catch (err) {
              out.callHistoryError = err.message.slice(0, 200);
            }
          }
          for (const c of r.recordings) {
            if (c.skip) bump("iphone_call", c.skip);
            else out.iphone_call.push({
              source: "iphone_call",
              ref: c.ref,
              file: c.file,
              bytes: c.bytes,
              filename: path.basename(c.file),
              contentType: CONTENT_TYPES[path.extname(c.file).toLowerCase()] ?? "audio/mp4",
              occurredAt: c.createdAt ?? new Date(fs.statSync(c.file).mtime),
              durationSec: c.durationSec,
              title: c.title,
              participants: c.participant ? [c.participant] : null,
              participantFrom: c.participantFrom ?? null,
              payload: { note_id: c.noteId, attachment_id: c.attachmentId, ...(c.appleTranscript ? { apple_transcript: c.appleTranscript } : {}) },
              when: c.createdAt,
            });
          }
        }
        if (wantNotes) {
          for (const n of r.notes) {
            if (n.skip) bump("apple_note", n.skip);
            else out.apple_note.push({ source: "apple_note", ref: `apple_note:${n.id}`, text: n.text, title: n.title, folder: n.folder, createdAt: n.createdAt ?? n.modifiedAt ?? new Date(), modifiedAt: n.modifiedAt, when: n.modifiedAt ?? n.createdAt });
          }
        }
      } finally {
        closeCopy(copy);
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.discover) {
    console.log(discover({ ...defaultPaths(), voiceMemosDirs: args.voiceMemosDirs, notesDir: args.notesDir }));
    return;
  }
  const log = makeLogger(args.dryRun ? null : args.logFile);
  const cfg = loadConfig(args.config);
  const state = readState(args.state);
  const token = args.dryRun ? "" : readToken();
  if (!args.dryRun) {
    if (!args.url) throw new Error("STROUT_VAULT_URL is not set");
    if (!token) throw new Error("no token: store it with `security add-generic-password -U -s strout-vault -a apple-media -w '<token>'` (or set STROUT_VAULT_TOKEN)");
  }

  const found = collect(args, cfg);
  // Which items this run considers: newer than the floor (unless --backfill), on or after --since, not already sent.
  const firstRun = !state.started_at;
  const floor = args.backfill ? null : new Date(state.started_at ?? Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86400_000);
  const inWindow = (when) => (!floor || !when || when >= floor) && (!args.since || !when || when >= args.since);
  const plan = {};
  const already = {};
  for (const src of SOURCES) {
    plan[src] = [];
    already[src] = 0;
    for (const it of found[src]) {
      const sent = state[src][it.ref];
      const unchanged = src === "apple_note" ? sent && it.modifiedAt && sent === it.modifiedAt.toISOString() : !!sent;
      if (unchanged) already[src]++;
      else if (!inWindow(it.when)) found.skipped[src].before_window = (found.skipped[src].before_window ?? 0) + 1;
      else plan[src].push(it);
    }
  }

  if (args.dryRun) {
    console.log(`[apple-media] DRY RUN: nothing was uploaded and the state file was not touched${args.backfill ? " (backfill: every item, not just new ones)" : ""}${args.since ? ` (since ${args.since.toISOString().slice(0, 10)})` : ""}`);
    console.log(`  ${"source".padEnd(12)} ${"would send".padStart(10)} ${"bytes".padStart(14)} ${"already sent".padStart(12)}  skipped`);
    for (const src of SOURCES) {
      const bytes = plan[src].reduce((n, it) => n + (it.bytes ?? Buffer.byteLength(it.text ?? "", "utf8")), 0);
      console.log(`  ${src.padEnd(12)} ${String(plan[src].length).padStart(10)} ${String(bytes).padStart(14)} ${String(already[src]).padStart(12)}  ${fmtCounts(found.skipped[src])}`);
    }
    if (found.duplicateCopies) console.log(`  (${found.duplicateCopies} raw "moments" copies of call recordings skipped: each call is sent once)`);
    if (found.otherAudio) console.log(`  (${found.otherAudio} other audio attachment(s) in Notes, not call recordings, are never sent)`);
    if (found.found.voice_memo === false) console.log("  Voice Memos: no CloudRecordings.db found (run --discover)");
    if (found.found.notes === false) console.log("  Notes: no NoteStore.sqlite found (run --discover)");
    return;
  }

  const vault = new Vault(args.url, token, log);
  const scanned = Object.fromEntries(SOURCES.map((s) => [s, found[s].length]));
  const run = await vault.call("POST", "/runs", { collector: { name: "apple-media", version: VERSION, host: os.hostname() }, counts_in: { scanned, skipped_on_mac: found.skipped, backfill: args.backfill } });
  const runId = run.run_id;
  const result = Object.fromEntries(SOURCES.map((s) => [s, {}]));
  const tally = (src, what) => (result[src][what] = (result[src][what] ?? 0) + 1);
  let errors = 0;
  let lastError = null;
  const save = () => writeState(args.state, { ...state, started_at: state.started_at ?? (floor ?? new Date()).toISOString() });
  try {
    for (const src of ["voice_memo", "iphone_call"]) {
      for (const it of plan[src]) {
        try {
          it.sha256 = await sha256File(it.file);
          it.runId = runId;
          const r = await vault.sendFile(it);
          tally(src, r.duplicate ? "duplicate" : "created");
          log(`${src} ${it.ref}: ${r.duplicate ? "already in the vault" : "sent"} (interaction ${r.interaction_id ?? "?"}, ${it.bytes} bytes)`);
          state[src][it.ref] = it.sha256;
          save();
        } catch (err) {
          errors++;
          lastError = err.message.slice(0, 200);
          tally(src, "error");
          log(`${src} ${it.ref}: FAILED ${lastError}`);
          if (err.status === 401 || err.status === 403) throw err;
        }
      }
    }
    // Calls sent before their number was known: tell the vault who they were with, once.
    state.call_participants = state.call_participants ?? {};
    for (const it of found.iphone_call) {
      if (!it.participantFrom || !state.iphone_call[it.ref] || state.call_participants[it.ref] || plan.iphone_call.includes(it)) continue;
      try {
        const r = await vault.call("POST", "/participants", { source: "iphone_call", source_ref: it.ref, participants_raw: it.participants, run_id: runId });
        state.call_participants[it.ref] = r.status;
        tally("iphone_call", `participants_${r.status}`);
        save();
      } catch (err) {
        errors++;
        lastError = err.message.slice(0, 200);
        log(`iphone_call ${it.ref}: participants FAILED ${lastError}`);
        if (err.status === 401 || err.status === 403) throw err;
      }
    }
    for (const it of plan.apple_note) {
      try {
        const r = await vault.call("POST", "/note", { source: "apple_note", source_ref: it.ref, occurred_at: it.createdAt.toISOString(), modified_at: it.modifiedAt?.toISOString() ?? null, title: it.title, folder: it.folder, text: it.text, run_id: runId });
        tally("apple_note", r.status);
        state.apple_note[it.ref] = it.modifiedAt?.toISOString() ?? new Date().toISOString();
        save();
      } catch (err) {
        errors++;
        lastError = err.message.slice(0, 200);
        tally("apple_note", "error");
        log(`apple_note ${it.ref}: FAILED ${lastError}`);
        if (err.status === 401 || err.status === 403) throw err;
      }
    }
    if (firstRun) save();
  } finally {
    await vault.call("POST", `/runs/${runId}/finish`, { counts_in: { sent: result }, ok: errors === 0, error: lastError }).catch((err) => log(`could not close run ${runId}: ${err.message}`));
  }
  log(`done (run ${runId}): ${SOURCES.map((s) => `${s} ${fmtCounts(result[s])}`).join("; ")}; already sent ${fmtCounts(already)}; skipped on the Mac ${SOURCES.map((s) => `${s} ${fmtCounts(found.skipped[s])}`).join("; ")}`);
  if (errors) process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof AccessError || err instanceof SchemaError) console.error(`[apple-media] ${err.message}`);
  else console.error(`[apple-media] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

