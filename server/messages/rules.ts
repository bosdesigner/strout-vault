// Ben's hand-written rules for messages, read from YAML so they can be edited without a deploy:
//   config/message_routing.yml   party id -> workspace, email domain -> workspace
//   config/message_blocklist.yml senders (emails, domains, phones) whose messages are never stored
// Both files ship with commented examples only; a missing or empty file means "no rules".
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { normalizeEmail, normalizePhone } from "./identity.ts";

export interface RoutingRules {
  parties: Map<number, string>;
  domains: Map<string, string>;
}

export interface Blocklist {
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
}

export interface MessageRules {
  routing: RoutingRules;
  blocklist: Blocklist;
}

export function emptyRules(): MessageRules {
  return { routing: { parties: new Map(), domains: new Map() }, blocklist: { emails: new Set(), domains: new Set(), phones: new Set() } };
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
  const out: RoutingRules = { parties: new Map(), domains: new Map() };
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
  };
}

export function loadMessageRules(dir: string): MessageRules {
  return {
    routing: parseRouting(readYaml(path.join(dir, "message_routing.yml"))),
    blocklist: parseBlocklist(readYaml(path.join(dir, "message_blocklist.yml"))),
  };
}
