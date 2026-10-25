// Where leads come from. Both sources are read-only: the platform's Postgres (AnotherStoryBLDR's
// `leads` and `site_leads`, through a SELECT-only role) and the Airtable "Client Pipeline" base,
// which anotherstory.com's intake forms still write to. The vault never writes back to either.

import pg from "pg";

export type LeadOrigin = "platform_leads" | "platform_site_leads" | "airtable_contact" | "airtable_contractor_intake" | "airtable_archived";

export interface LeadInput {
  origin: LeadOrigin;
  originId: string;
  leadType: "homeowner" | "contractor" | "other";
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  zip: string | null;
  market: string | null;
  channel: string | null;
  stage: string | null;
  status: string | null;
  notes: string | null;
  details: Record<string, unknown>;
  submittedAt: string | null;
  originUpdatedAt: string | null;
}

/** Our own, test and smoke traffic: never a lead. Same rule as the platform's admin leads page, plus the common typo. */
export const INTERNAL_EMAIL = /(@anotherstory\.com$|@amotherstory\.com$|@stroutarch\.com$|\+prodsmoke|\+covsmoke|\+smoke|\+test)/i;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = (typeof v === "object" && "name" in (v as object) ? String((v as { name: unknown }).name) : String(v)).trim();
  return s ? s : null;
};
const isoOrNull = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));

// ---- the platform (AnotherStoryBLDR Postgres) ---------------------------------------------

export async function readPlatformLeads(databaseUrl: string): Promise<LeadInput[]> {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl) || databaseUrl.includes("host=/");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000, ssl: local ? undefined : { rejectUnauthorized: true } });
  try {
    const [leads, site] = await Promise.all([
      pool.query(
        `select id, email, name, phone, company, zip, market_slug, market_zip, kind, source, source_ref, lead_type, status, recruit_stage, recruit_warm,
                notes, intent, query, territory_id, agent_owner, created_at, last_touched_at, recruit_stage_at
           from leads`,
      ),
      pool.query(
        `select id, email, host, address, zip, status, coverage, source, matched_territory_slug, territory_id, in_market, chosen_style,
                report_sent_at, call_booked_at, created_at
           from site_leads`,
      ),
    ]);
    const out: LeadInput[] = [];
    for (const r of leads.rows) {
      out.push({
        origin: "platform_leads",
        originId: String(r.id),
        leadType: r.lead_type === "homeowner" || r.lead_type === "contractor" ? r.lead_type : "other",
        name: str(r.name),
        email: str(r.email),
        phone: str(r.phone),
        company: str(r.company),
        address: null,
        zip: str(r.zip) ?? str(r.market_zip),
        market: str(r.market_slug),
        channel: [str(r.source), str(r.kind)].filter(Boolean).join(" · ") || null,
        stage: str(r.recruit_stage),
        status: str(r.status),
        notes: str(r.notes),
        details: compact({ intent: str(r.intent), query: str(r.query), territory_id: str(r.territory_id), agent_owner: str(r.agent_owner), recruit_warm: r.recruit_warm ?? null, source_ref: str(r.source_ref) }),
        submittedAt: isoOrNull(r.created_at),
        originUpdatedAt: isoOrNull(r.last_touched_at ?? r.recruit_stage_at),
      });
    }
    for (const r of site.rows) {
      out.push({
        origin: "platform_site_leads",
        originId: String(r.id),
        leadType: "homeowner",
        name: null,
        email: str(r.email),
        phone: null,
        company: null,
        address: str(r.address),
        zip: str(r.zip),
        market: str(r.matched_territory_slug) ?? str(r.territory_id),
        channel: [str(r.host), str(r.source)].filter(Boolean).join(" · ") || "funnel",
        stage: r.call_booked_at ? "call booked" : r.report_sent_at ? "report sent" : null,
        status: str(r.status),
        notes: null,
        details: compact({ coverage: str(r.coverage), in_market: r.in_market ?? null, chosen_style: str(r.chosen_style), call_booked_at: isoOrNull(r.call_booked_at), report_sent_at: isoOrNull(r.report_sent_at) }),
        submittedAt: isoOrNull(r.created_at),
        originUpdatedAt: isoOrNull(r.call_booked_at ?? r.report_sent_at),
      });
    }
    return out;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---- Airtable "Client Pipeline" -------------------------------------------------------------

/** Table ids are stable across renames. */
export const AIRTABLE_TABLES: Array<{ id: string; name: string; origin: LeadOrigin; leadType: LeadInput["leadType"] }> = [
  { id: "tblcCFpiLhaWcmgMz", name: "contact", origin: "airtable_contact", leadType: "homeowner" },
  { id: "tblNuWTLJdDorHW6Q", name: "contractor_intake", origin: "airtable_contractor_intake", leadType: "contractor" },
  { id: "tblIE6xAPvvxWV89L", name: "archived", origin: "airtable_archived", leadType: "homeowner" },
];

/** Fields mapped to columns; everything else with a value lands in `details`. */
const AIRTABLE_MAPPED = new Set(["email", "formatted email", "name", "phone", "Notes", "stage", "address", "status", "vcard", "recorded", "last modified", "Created", "Created (tb automated)"]);

interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export function mapAirtableRecord(table: (typeof AIRTABLE_TABLES)[number], rec: AirtableRecord): LeadInput {
  const f = rec.fields;
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (AIRTABLE_MAPPED.has(k) || v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    details[k] = Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "object" ? str(v) : v;
  }
  return {
    origin: table.origin,
    originId: rec.id,
    leadType: table.leadType,
    name: str(f.name),
    email: str(f.email) ?? str(f["email secondary"]),
    phone: str(f.phone),
    company: null,
    address: str(f.address),
    zip: null,
    market: null,
    channel: `airtable · ${table.name}`,
    stage: str(f.stage),
    status: table.origin === "airtable_archived" ? "archived" : str(f.status),
    notes: str(f.Notes),
    details,
    submittedAt: isoOrNull(f["Created (tb automated)"] ?? f.recorded ?? f.Created ?? rec.createdTime),
    originUpdatedAt: isoOrNull(f["last modified"] ?? rec.createdTime),
  };
}

export async function readAirtableLeads(opts: { token: string; baseId: string; apiUrl: string; fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void> }): Promise<LeadInput[]> {
  const out: LeadInput[] = [];
  for (const table of AIRTABLE_TABLES) {
    let offset: string | undefined;
    do {
      const url = new URL(`${opts.apiUrl.replace(/\/$/, "")}/v0/${opts.baseId}/${table.id}`);
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await opts.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${opts.token}` } });
        if (res.status !== 429) break;
        await opts.sleep(30_000); // Airtable asks for 30 s after a 429
      }
      if (!res!.ok) {
        const body = (await res!.text()).slice(0, 300);
        throw new Error(`airtable ${table.name}: HTTP ${res!.status} ${body}`);
      }
      const page = (await res!.json()) as { records: AirtableRecord[]; offset?: string };
      for (const rec of page.records ?? []) out.push(mapAirtableRecord(table, rec));
      offset = page.offset;
      if (offset) await opts.sleep(220); // 5 requests per second per base
    } while (offset);
  }
  return out;
}
