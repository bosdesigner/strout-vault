# Leads (Jarvis step 3)

Every lead becomes someone the vault knows, so Jarvis can tell you who came in, who you haven't
talked to yet, and what was said once you did.

## Where leads come from

The hourly worker's `leads` step reads three places. All of them are **read-only**, and the vault
never writes back.

| Source | What | Secret on the worker |
|---|---|---|
| AnotherStoryBLDR `leads` | the unified lead table: contractor gate sign-ups, consult form, recruits, and the frozen Airtable / Drive / TikTok backfill | `LEADS_DATABASE_URL` |
| AnotherStoryBLDR `site_leads` | the homeowner funnel on the territory sites (address, rendering, report sent, call booked) | `LEADS_DATABASE_URL` |
| Airtable **Client Pipeline** | `contact` (homeowner intake), `contractor_intake`, `archived` | `AIRTABLE_TOKEN` |

Airtable is still live. As of 2026-10-25, anotherstory.com's intake forms had added 23 contacts and
7 contractor intakes since the 2026-09-21 freeze. 26 of those 27 people were in neither platform table.
The vault reads Airtable so they are not lost. The platform's own rule (AnotherStoryBLDR never reads
Airtable at runtime) is unchanged. The question of where those forms should write instead is for Logan's site.

## What a sync does

1. Upserts each source record into `lead_records` by (origin, record id). A re-sync updates stage,
   status and notes in place. A source that is down is skipped, and nothing it holds is deleted.
2. Resolves the person. It matches an existing party by email (case-insensitive), then by phone
   (last ten digits), or else creates a party. The same person across several sources becomes one
   party. A matched party gets the email, phone and address it was missing, and a real name replaces
   a placeholder name, but nothing is overwritten.
3. Gives the party a `prospect` role in `LEADS_WORKSPACE` (`another_story`), with detail
   "homeowner lead" or "contractor lead". Leads then show up on **People**, in `get_party`, and in
   the extraction step's roster, so Claude can match a lead to a speaker on their first call.
4. Finds recordings whose title names a lead ("Kaylen Apodaca: AnotherStory Assessment") and queues
   a `link_party_interaction` proposal for each. Approving it on **Review** ties the call to the lead.
   Leads are source data, so steps 1–3 are written directly. Only these call links go through review.

Our own test and smoke traffic (`@anotherstory.com`, `@stroutarch.com`, `+test`, `+smoke`…) is skipped,
and so is any record with neither an email nor a phone.

## Where you see them

- **Leads** page (`/leads`, owner only): one row per person, newest first. Each row shows source,
  stage, status, the last call, and **no call yet** when nobody has talked to them since they came in.
  Filter by homeowner or contractor, or tick **Needs follow-up**.
- **MCP `list_leads`**: the same list for agents, with `needs_follow_up`, `lead_type`, `since` and
  `query`. `get_party` now includes a person's lead submissions.

"Needs follow-up" means the latest status is not dead, converted, archived or lost, and there is no
recorded conversation since the latest submission.

## Turning it on

1. Apply `db/migrations/0008_leads.sql` in the vault's Neon SQL Editor (after 0007).
2. **A read-only role on AnotherStoryBLDR's database.** This is done: `vault_ro` was created on
   2026-10-25 in project `anotherstorybldr` (branch `main`). It can log in and SELECT on `public.leads`
   and `public.site_leads` only, with no role memberships. To recreate it, run this in the SQL Editor,
   **not** through the console's Roles page or the Neon API. Roles made there join `neon_superuser`,
   which can write every table.

   ```sql
   create role vault_ro with login nocreaterole nocreatedb password '<a long random password>';
   grant usage on schema public to vault_ro;
   grant select on public.leads, public.site_leads to vault_ro;
   ```

   The worker's `LEADS_DATABASE_URL` is
   `postgresql://vault_ro:<password>@ep-lively-rain-b84zr7e9-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require`.
3. **An Airtable token.** At https://airtable.com/create/tokens, create a token with the scope
   `data.records:read` and access to the **Client Pipeline** base only. It goes into the worker's `AIRTABLE_TOKEN`.
4. Pull and redeploy both Repls. Preview in the worker Shell (this reads the sources and writes nothing):

   ```bash
   npm run worker:dev -- --steps leads --dry-run
   ```

   Then run it for real with `npm run worker:dev -- --steps leads`. After that the hourly run keeps it current.

## Settings

| Secret (worker) | Default | |
|---|---|---|
| `LEADS_DATABASE_URL` | unset | AnotherStoryBLDR Postgres, SELECT-only role |
| `AIRTABLE_TOKEN` | unset | personal access token, `data.records:read` |
| `AIRTABLE_BASE_ID` | `appK6q2gwVCCc0gmF` | Client Pipeline |
| `LEADS_WORKSPACE` | `another_story` | where the prospect role goes |

## Code map

```
server/leads/sources.ts     readers: platform leads + site_leads, Airtable (paged, 429-aware)
server/leads/sync.ts        upsert, person resolution, prospect role, call-link proposals
server/worker/leads.ts      the worker step
server/mcp/tools/leads.ts   list_leads
server/services/leads.ts, server/routes/leads.ts, client/src/pages/LeadsPage.tsx
db/migrations/0008_leads.sql
tests/api/leads.test.ts
```
