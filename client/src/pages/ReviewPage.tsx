import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, ExternalLink, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ReviewItem } from "@shared/types";
import { useWorkspace } from "@/lib/workspace";
import { formatDate, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";

type Filter = "open" | "all";

export default function ReviewPage() {
  const { param, current } = useWorkspace();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    document.title = "Review queue · Strout Vault";
  }, []);

  const queue = useQuery({
    queryKey: ["review", filter, param],
    queryFn: () => api<{ items: ReviewItem[]; openCount: number }>(`/review?status=${filter}${param}`),
    placeholderData: (prev) => prev,
  });
  const items = queue.data?.items ?? [];
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" }) => api<{ item: ReviewItem; applied: string[] }>(`/review/${id}/decide`, { method: "POST", json: { decision } }),
    onSuccess: ({ item }) => {
      qc.setQueryData<{ items: ReviewItem[]; openCount: number }>(["review", filter, param], (old) => {
        if (!old) return old;
        const next = filter === "open" ? old.items.filter((i) => i.id !== item.id) : old.items.map((i) => (i.id === item.id ? item : i));
        return { items: next, openCount: Math.max(0, old.openCount - 1) };
      });
      void qc.invalidateQueries({ queryKey: ["review-count"] });
      void qc.invalidateQueries({ queryKey: ["review"] });
      if (item.interaction) void qc.invalidateQueries({ queryKey: ["recording", item.interaction.id] });
    },
  });

  const workspaceItems = items.filter((i) => i.itemType === "interaction_workspace" && i.status === "open");
  const bulk = useMutation({
    mutationFn: (ids: number[]) => api<{ done: number; failed: Array<{ id: number; error: string }>; openCount: number }>("/review/bulk", { method: "POST", json: { ids, decision: "approve" } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["review"] });
      void qc.invalidateQueries({ queryKey: ["review-count"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const act = useCallback(
    (decision: "approve" | "reject") => {
      const it = items[selected];
      if (!it || it.status !== "open" || decide.isPending) return;
      decide.mutate({ id: it.id, decision });
    },
    [items, selected, decide],
  );

  // Keyboard: j/k move, a approve, r reject, enter/o open the moment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, items.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "a") {
        e.preventDefault();
        act("approve");
      } else if (e.key === "r") {
        e.preventDefault();
        act("reject");
      } else if ((e.key === "Enter" || e.key === "o") && items[selected]?.interaction) {
        const it = items[selected];
        window.open(`/r/${it.interaction!.id}${it.startSec != null ? `?t=${Math.floor(it.startSec)}` : ""}`, "_blank");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, act]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            Proposals from the pipeline{current ? ` for ${current.name}` : ""}. <kbd className="rounded border px-1">a</kbd> approve · <kbd className="rounded border px-1">r</kbd> reject · <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd> move · <kbd className="rounded border px-1">o</kbd> open the moment
          </p>
        </div>
        {workspaceItems.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            disabled={bulk.isPending}
            data-testid="approve-all-workspaces"
            onClick={() => {
              if (window.confirm(`Approve all ${workspaceItems.length} workspace proposals shown? Each recording is filed under the proposed workspace.`)) bulk.mutate(workspaceItems.map((i) => i.id));
            }}
          >
            <Check className="h-4 w-4" /> Approve all {workspaceItems.length} workspace proposals
          </Button>
        )}
        <div className="inline-flex rounded-lg bg-muted p-1 text-sm" role="tablist" aria-label="Show">
          {(["open", "all"] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} type="button" onClick={() => setFilter(f)} className={cn("rounded-md px-3 py-1 capitalize", filter === f && "bg-background shadow-sm")}>
              {f === "open" ? `Open${queue.data ? ` (${queue.data.openCount})` : ""}` : "All"}
            </button>
          ))}
        </div>
      </div>

      {queue.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading review queue">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : queue.isError ? (
        <EmptyState title="Could not load the queue">{(queue.error as Error).message}</EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title={filter === "open" ? "Nothing to review" : "No proposals yet"}>
          {filter === "open" ? "New proposals appear here after each recording is processed." : "The pipeline has not proposed anything for this workspace."}
        </EmptyState>
      ) : (
        <ol ref={listRef} className="space-y-2" aria-label="Proposals" data-testid="review-list">
          {items.map((it, i) => {
            const open = it.status === "open";
            const momentHref = it.interaction ? `/r/${it.interaction.id}${it.startSec != null ? `?t=${Math.floor(it.startSec)}` : ""}` : null;
            return (
              <li
                key={it.id}
                data-index={i}
                data-testid="review-item"
                data-status={it.status}
                data-selected={i === selected || undefined}
                onClick={() => setSelected(i)}
                className={cn("rounded-lg border bg-card p-4 transition-shadow", i === selected && "ring-2 ring-ring", !open && "opacity-70")}
              >
                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <Badge variant={open ? "warning" : it.status === "approved" ? "success" : "muted"} className="capitalize">{open ? it.itemType.replace(/_/g, " ") : it.status}</Badge>
                  <p className="min-w-0 flex-1 text-sm font-medium" data-testid="review-reason">
                    {it.reason ?? describe(it)}
                  </p>
                  {it.confidence != null && <span className="text-xs text-muted-foreground tabular">{Math.round(it.confidence * 100)}%</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {it.interaction && (
                    <Link to={momentHref!} className="inline-flex items-center gap-1 hover:text-foreground hover:underline underline-offset-2" data-testid="review-moment">
                      <ExternalLink className="h-3 w-3" />
                      {it.interaction.title?.trim() || "Untitled recording"}
                      {it.startSec != null && <span className="tabular">at {formatTimestamp(it.startSec)}</span>}
                    </Link>
                  )}
                  {it.interaction?.occurredAt && <span>{formatDate(it.interaction.occurredAt)}</span>}
                  {it.party && (
                    <Link to={`/p/${it.party.id}`} className="hover:underline underline-offset-2">{it.party.name}</Link>
                  )}
                  {it.speakerLabel && <span>label: {it.speakerLabel}</span>}
                </div>
                {open && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={(e) => { e.stopPropagation(); setSelected(i); decide.mutate({ id: it.id, decision: "approve" }); }} disabled={decide.isPending} data-testid="review-approve">
                      <Check /> Approve <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 text-[10px]">a</kbd>
                    </Button>
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setSelected(i); decide.mutate({ id: it.id, decision: "reject" }); }} disabled={decide.isPending} data-testid="review-reject">
                      <X /> Reject <kbd className="ml-1 rounded bg-muted px-1 text-[10px]">r</kbd>
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function describe(it: ReviewItem): string {
  if (it.itemType === "participant_match" && it.party) {
    return `${it.speakerLabel ?? "A speaker"} is probably ${it.party.name}${it.confidence != null ? ` (${it.confidence.toFixed(2)})` : ""}`;
  }
  const p = it.proposal;
  const who = typeof p.proposed_by === "string" && p.source === "mcp" ? ` · proposed by ${p.proposed_by} (agent)` : "";
  if (it.itemType === "new_fact" && typeof p.text === "string") return `New ${String(p.kind ?? "fact")}: "${p.text}"${who}`;
  if (it.itemType === "new_party" && typeof p.name === "string") return `New ${String(p.kind ?? "party")}: ${p.name}${who}`;
  if (it.itemType === "party_edit" && it.party) return `Edit ${it.party.name}: ${Object.keys((p.changes as Record<string, unknown>) ?? {}).join(", ")}${who}`;
  if (it.itemType === "link_project_interaction") return `Link project #${String(p.project_id)} to this recording${who}`;
  if (it.itemType === "link_party_interaction" && it.party) return `Tag ${it.party.name} on this recording${it.speakerLabel ? ` as ${it.speakerLabel}` : ""}${who}`;
  if (it.itemType === "new_relationship") return `New relationship: #${String(p.from_party_id)} ${String(p.kind)} #${String(p.to_party_id)}${who}`;
  if (it.itemType === "interaction_workspace") return `File under ${String(p.workspace_id)}${typeof p.confidence === "number" ? ` (${Math.round(p.confidence * 100)}% sure)` : ""}`;
  return `${it.itemType.replace(/_/g, " ")} proposal${who}`;
}
