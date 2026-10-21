import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SearchX, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import type { SearchResponse } from "@shared/types";
import { formatDate, formatTimestamp } from "@/lib/format";
import { SourceIcon } from "@/components/SourceIcon";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PartyPicker } from "@/components/PartyPicker";
import { useWorkspaces } from "@/hooks/useWorkspaces";

const ALL = "__all";

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const workspace = params.get("workspace") ?? "";
  const partyId = Number(params.get("party"));
  const party = partyId > 0 ? { id: partyId, name: params.get("partyName") ?? `#${partyId}` } : null;
  const workspaces = useWorkspaces();

  useEffect(() => {
    document.title = q ? `“${q}” · Strout Vault` : "Search · Strout Vault";
  }, [q]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!("page" in patch)) next.delete("page");
    setParams(next);
  };

  const qs = new URLSearchParams({ q, page: String(page) });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (workspace) qs.set("workspace", workspace);
  if (party) qs.set("party", String(party.id));
  const result = useQuery({
    queryKey: ["search", qs.toString()],
    queryFn: () => api<SearchResponse>(`/search?${qs.toString()}`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">{q ? <>Results for <span className="text-primary break-words">{q}</span></> : "Search"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quote a phrase, use <code className="rounded bg-muted px-1">OR</code> between words, or <code className="rounded bg-muted px-1">-word</code> to exclude.
          {result.data && <span className="ml-2 tabular">{result.data.tookMs} ms</span>}
        </p>
      </div>
      <div className="mb-6 flex flex-wrap items-end gap-3" role="group" aria-label="Search filters">
        <div className="space-y-1">
          <Label htmlFor="s-from" className="text-xs text-muted-foreground">From</Label>
          <Input id="s-from" type="date" className="h-8 w-[9.5rem]" value={from} onChange={(e) => update({ from: e.target.value || null })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s-to" className="text-xs text-muted-foreground">To</Label>
          <Input id="s-to" type="date" className="h-8 w-[9.5rem]" value={to} onChange={(e) => update({ to: e.target.value || null })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s-workspace" className="text-xs text-muted-foreground">Workspace</Label>
          <Select value={workspace || ALL} onValueChange={(v) => update({ workspace: v === ALL ? null : v })}>
            <SelectTrigger id="s-workspace" className="h-8 w-[11rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All workspaces</SelectItem>
              {(workspaces.data ?? []).map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-[12rem] flex-1 max-w-xs">
          <Label htmlFor="s-person" className="text-xs text-muted-foreground">Person</Label>
          <PartyPicker id="s-person" multiple={false} placeholder="Anyone" value={party ? [party] : []} onChange={(v) => update(v[0] ? { party: String(v[0].id), partyName: v[0].name } : { party: null, partyName: null })} />
        </div>
      </div>

      {!q.trim() ? (
        <EmptyState title="Search every transcript">Type in the box at the top, or press <kbd className="rounded border px-1">/</kbd>.</EmptyState>
      ) : result.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : result.isError ? (
        <EmptyState title="Search failed">{(result.error as Error).message}</EmptyState>
      ) : result.data!.groups.length === 0 ? (
        <EmptyState icon={<SearchX />} title="No matches">Try fewer words, drop the quotes, or widen the date range.</EmptyState>
      ) : (
        <>
          <ol className="space-y-3" data-testid="search-results">
            {result.data!.groups.map((g) => (
              <li key={g.interactionId} className="rounded-lg border bg-card p-4" data-testid="search-group">
                <div className="flex items-baseline gap-2">
                  <SourceIcon source={g.source} className="self-center" />
                  <Link to={`/r/${g.interactionId}`} className="font-medium hover:underline underline-offset-2 truncate">{g.title?.trim() || "Untitled recording"}</Link>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular">{formatDate(g.occurredAt)} · {g.hitCount} hit{g.hitCount === 1 ? "" : "s"}</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {g.lines.map((l) => (
                    <li key={l.segmentId}>
                      <Link
                        to={`/r/${g.interactionId}?t=${Math.floor(l.startSec)}`}
                        className="flex gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                        data-testid="search-line"
                      >
                        <span className="w-12 shrink-0 text-xs tabular text-muted-foreground pt-0.5">{formatTimestamp(l.startSec)}</span>
                        <span className="min-w-0">
                          {l.speaker && <span className="mr-1.5 text-xs font-medium text-muted-foreground">{l.speaker}</span>}
                          {l.parts.map((p, i) => (p.m ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              <ChevronLeft /> Previous
            </Button>
            <span className="text-xs text-muted-foreground tabular">Page {page}</span>
            <Button variant="outline" size="sm" disabled={!result.data!.hasMore} onClick={() => update({ page: String(page + 1) })}>
              Next <ChevronRight />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
