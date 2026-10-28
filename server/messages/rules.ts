// Ben's hand-written rules for messages, read from YAML so they can be edited without a deploy:
//   config/message_routing.yml   party id -> workspace, email domain -> workspace, Apple Notes folder -> workspace,
//                                DM source (tiktok, instagram) -> workspace for threads nobody known is on
//   config/message_blocklist.yml senders (emails, domains, phones, handles) whose messages are never stored
// Both files ship with commented examples only; a missing or empty file means "no rules".
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { normalizeEmail, normalizeIdentifier, normalizePhone } from "./identity.ts";

export interface RoutingRules {
  parties: Map<number, string>;
  domains: Map<string, string>;
  /** Apple Notes folder name (lowercased) -> workspace, for notes the Mac collector sends. */
  notesFolders: Map<string, string>;
  /**
   * DM source (tiktok, instagram) -> workspace, for a new thread whose participants map to no
   * workspace at all. Participants that do map always win; phalanx is never taken from here.
   */
  sources: Map<string, string>;
}

export interface Blocklist {
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
  /** "<platform>:<username>" */
  handles: Set<string>;
}

export interface MessageRules {
  routing: RoutingRules;
  blocklist: Blocklist;
}

export function emptyRules(): MessageRules {
  return { routing: { parties: new Map(), domains: new Map(), notesFolders: new Map(), sources: new Map() }, blocklist: { emails: new Set(), domains: new Set(), phones: new Set(), handles: new Set() } };
}

function readYaml(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const doc = parse(fs.readFileSync(file, "utf8"));
  if (doc == null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${path.basename(file)} must be a mapping`);
  return doc as Record<string, unknown>;
}

const WS_ID = /^[a-z0-9_-]{1,100}$/;

export function parseRouting(doc: Record<string, unknown>): RoutingRules {
  const out: RoutingRules = { parties: new Map(), domains: new Map(), notesFolders: new Map(), sources: new Map() };
  const parties = (doc.parties ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(parties)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`message_routing.yml: party id "${k}" is not a positive integer`);
    if (typeof v !== "string" || !WS_ID.test(v)) throw new Error(`message_routing.yml: party ${k} maps to an invalid workspace id`);
    out.parties.set(id, v);
  }
  const domains = (doc.domains ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(domains)) {
    if (typeof v !== "string" || !WS_ID.test(v)) throw new Error(`message_routing.yml: domain ${k} maps to an invalid workspace id`);
    out.domains.set(k.trim().toLowerCase().replace(/^@/, ""), v);
  }
  const folders = (doc.apple_notes_folders ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(folders)) {
    if (typeof v !== "string" || !WS_ID.test(v)) throw new Error(`message_routing.yml: notes folder ${k} maps to an invalid workspace id`);
    out.notesFolders.set(k.trim().toLowerCase(), v);
  }
  const sources = (doc.dm_sources ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(sources)) {
    const src = k.trim().toLowerCase();
    if (src !== "tiktok" && src !== "instagram") throw new Error(`message_routing.yml: dm_sources key "${k}" must be tiktok or instagram`);
    if (typeof v !== "string" || !WS_ID.test(v)) throw new Error(`message_routing.yml: dm_sources ${k} maps to an invalid workspace id`);
    out.sources.set(src, v);
  }
  return out;
}

export function parseBlocklist(doc: Record<string, unknown>): Blocklist {
  const list = (key: string) => {
    const v = doc[key] ?? [];
    if (!Array.isArray(v)) throw new Error(`message_blocklist.yml: ${key} must be a list`);
    return v.map((x) => String(x));
  };
  return {
    emails: new Set(list("emails").map(normalizeEmail).filter((x): x is string => !!x)),
    domains: new Set(list("domains").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
    phones: new Set(list("phones").map(normalizePhone).filter((x): x is string => !!x)),
    handles: new Set(
      list("handles")
        .map((h) => normalizeIdentifier(h))
        .filter((x) => x?.kind === "handle")
        .map((x) => x!.value),
    ),
  };
}

export function loadMessageRules(dir: string): MessageRules {
  return {
    routing: parseRouting(readYaml(path.join(dir, "message_routing.yml"))),
    blocklist: parseBlocklist(readYaml(path.join(dir, "message_blocklist.yml"))),
  };
}
