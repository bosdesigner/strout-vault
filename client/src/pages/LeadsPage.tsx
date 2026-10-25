import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { formatDate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";

interface LeadPerson {
  partyId: number;
  name: string;
  email: string | null;
  phone: string | null;
  leadType: string;
  latestAt: string | null;
  firstAt: string | null;
  submissions: number;
  origins: string[];
  channel: string | null;
  stage: string | null;
  status: string | null;
  address: string | null;
  lastConversation: { id: number; title: string | null; occurredAt: string | null } | null;
  talkedSince: boolean;
  openFacts: number;
}

const ORIGIN: Record<string, string> = {
  platform_leads: "Platform",
  platform_site_leads: "Funnel",
  airtable_contact: "Airtable",
  airtable_contractor_intake: "Airtable",
  airtable_archived: "Airtable (archived)",
};

type TypeFilter = "" | "homeowner" | "contractor";

/** Owner only: every lead from the platform, the funnel and Airtable, and who still needs a call. */
export default function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const { param } = useWorkspace();
  const q = params.get("q") ?? "";
  const type = (params.get("type") ?? "") as TypeFilter;
  const followUp = params.get("followUp") === "1";
  useEffect(() => {
    document.title = "Leads · Strout Vault";
  }, []);
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (type) qs.set("type", type);
  if (followUp) qs.set("followUp", "1");
  const list = useQuery({
    queryKey: ["leads", qs.toString(), param],
    queryFn: () => api<{ items: LeadPerson[]; counts: { total: number; last7: number; needsFollowUp: number } }>(`/leads?${qs.toString()}${param}`),
    placeholderData: (prev) => prev,
  });
  const counts = list.data?.counts;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who came in through the platform, the website funnel or the Airtable intake forms, newest first.
          {counts ? ` ${counts.total} people · ${counts.last7} this week · ${counts.needsFollowUp} not talked to since they came in.` : ""}
        </p>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3" role="group" aria-label="Filters">
        <div className="relative min-w-[12rem] flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search leads" placeholder="Name, email, phone or address" className="h-8 pl-8" value={q} onChange={(e) => update({ q: e.target.value || null })} />
        </div>
        <div className="inline-flex rounded-lg bg-muted p-1 text-sm" role="tablist" aria-label="Lead type">
          {(["", "homeowner", "contractor"] as TypeFilter[]).map((t) => (
            <button key={t || "all"} role="tab" type="button" aria-selected={type === t} onClick={() => update({ type: t || null })} className={cn("rounded-md px-3 py-1 capitalize", type === t && "bg-background shadow-sm")}>
              {t || "All"}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={followUp} onChange={(e) => update({ followUp: e.target.checked ? "1" : null })} data-testid="follow-up-filter" />
          Needs follow-up
        </label>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : list.isError ? (
        <EmptyState title="Could not load leads">{(list.error as Error).message}</EmptyState>
      ) : !list.data.items.length ? (
        <EmptyState icon={<Inbox />} title={followUp ? "Everyone has been talked to" : "No leads yet"}>
          {followUp ? "Every open lead has a recorded conversation since they came in." : "Leads appear here after the worker's first leads sync."}
        </EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lead-list">
          {list.data.items.map((l) => (
            <li key={l.partyId} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-start sm:justify-between" data-testid="lead-row">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/p/${l.partyId}`} className="font-medium hover:underline">{l.name}</Link>
                  <Badge variant="muted" className="capitalize">{l.leadType}</Badge>
                  {l.stage && <Badge variant="outline">{l.stage}</Badge>}
                  {l.status && <span className="text-xs text-muted-foreground">{l.status}</span>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {[l.email, l.phone, l.address].filter(Boolean).join(" · ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[...new Set(l.origins.map((o) => ORIGIN[o] ?? o))].join(", ")}
                  {l.submissions > 1 ? ` · ${l.submissions} submissions` : ""}
                  {l.openFacts ? ` · ${l.openFacts} open item(s)` : ""}
                </p>
              </div>
              <div className="shrink-0 text-left text-xs sm:text-right">
                <p className="tabular" title={formatDate(l.latestAt, { withTime: true })}>came in {formatRelative(l.latestAt)}</p>
                {l.lastConversation ? (
                  <Link to={`/r/${l.lastConversation.id}`} className={cn("hover:underline", l.talkedSince ? "text-muted-foreground" : "font-medium text-amber-600 dark:text-amber-400")}>
                    last call {formatRelative(l.lastConversation.occurredAt)}
                  </Link>
                ) : (
                  <p className="font-medium text-destructive">no call yet</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
