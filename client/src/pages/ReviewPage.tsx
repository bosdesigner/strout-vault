import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, Copy, ExternalLink, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ReviewItem } from "@shared/types";
import { useWorkspace } from "@/lib/workspace";
import { formatDate, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";

type Filter = "today" | "open" | "all";

/** The follow-through step's items (Jarvis step 5 C): what Ben has to act on, in the order he should see it. */
const TODAY_TYPES = ["reply_needed", "nudge", "fact_status"];

type Draft = { channel: "email" | "text"; to: string; subject?: string | null; body: string; edited?: boolean };

export default function ReviewPage() {
  const { param, current } = useWorkspace();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    document.title = "Review queue · Strout Vault";
  }, []);

  // Today is the open queue narrowed to replies, nudges and done-checks.
  const status = filter === "today" ? "open" : filter;
  const queue = useQuery({
    queryKey: ["review", status, param],
    queryFn: () => api<{ items: ReviewItem[]; openCount: number }>(`/review?status=${status}${param}`),
    placeholderData: (prev) => prev,
  });
  const all = queue.data?.items ?? [];
  const todayCount = all.filter((i) => i.status === "open" && TODAY_TYPES.includes(i.itemType)).length;
  const items =
    filter === "today"
      ? all.filter((i) => TODAY_TYPES.includes(i.itemType)).sort((a, b) => TODAY_TYPES.indexOf(a.itemType) - TODAY_TYPES.indexOf(b.itemType) || a.id - b.id)
      : all;
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" }) => api<{ item: ReviewItem; applied: string[] }>(`/review/${id}/decide`, { method: "POST", json: { decision } }),
    onSuccess: ({ item }) => {
      qc.setQueryData<{ items: ReviewItem[]; openCount: number }>(["review", status, param], (old) => {
        if (!old) return old;
        const next = status === "open" ? old.items.filter((i) => i.id !== item.id) : old.items.map((i) => (i.id === item.id ? item : i));
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
          {(["today", "open", "all"] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} type="button" data-testid={`review-tab-${f}`} onClick={() => setFilter(f)} className={cn("rounded-md px-3 py-1 capitalize", filter === f && "bg-background shadow-sm")}>
              {f === "open" ? `Open${queue.data ? ` (${queue.data.openCount})` : ""}` : f === "today" ? `Today${queue.data && status === "open" ? ` (${todayCount})` : ""}` : "All"}
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
        <EmptyState icon={<ClipboardCheck />} title={filter === "all" ? "No proposals yet" : filter === "today" ? "Nothing waiting on you" : "Nothing to review"}>
          {filter === "today"
            ? "Replies to send, nudges and kept commitments appear here once the follow-through step runs."
            : filter === "open"
              ? "New proposals appear here after each recording is processed."
              : "The pipeline has not proposed anything for this workspace."}
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
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" data-testid="review-reason">
                      {leadsWithChange(it) ? describe(it) : it.reason ?? describe(it)}
                    </p>
                    {leadsWithChange(it) && it.reason && <p className="mt-0.5 text-sm text-muted-foreground" data-testid="review-evidence">{it.reason}</p>}
                  </div>
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
                  {it.project && (
                    <Link to={`/projects/${it.project.id}`} className="hover:underline underline-offset-2">{it.project.name}</Link>
                  )}
                  {it.speakerLabel && <span>label: {it.speakerLabel}</span>}
                  {(it.proposal.source === "extract" || it.proposal.source === "followthrough") && <span>found by Claude</span>}
                </div>
                {isDraft(it.proposal.draft) && <DraftBox item={it} draft={it.proposal.draft} />}
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

/** Agent, extraction and follow-through proposals lead with the change; their reason (the quote, the evidence) goes underneath. */
function leadsWithChange(it: ReviewItem): boolean {
  return ["new_fact", "new_party", "party_edit", "link_party_interaction", "link_project_interaction", "new_relationship", ...TODAY_TYPES].includes(it.itemType);
}

function isDraft(d: unknown): d is Draft {
  return !!d && typeof d === "object" && typeof (d as Draft).body === "string" && typeof (d as Draft).to === "string";
}

/**
 * The drafted reply on a follow-through item. Ben edits it here (saved when the field loses focus)
 * and copies it into Gmail or Messages; nothing is sent from the vault.
 */
function DraftBox({ item, draft }: { item: ReviewItem; draft: Draft }) {
  const qc = useQueryClient();
  const open = item.status === "open";
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setSubject(draft.subject ?? "");
    setBody(draft.body);
  }, [draft.subject, draft.body]);
  const save = useMutation({
    mutationFn: () => api<{ item: ReviewItem }>(`/review/${item.id}/draft`, { method: "PATCH", json: { body, ...(draft.channel === "email" ? { subject } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["review"] }),
  });
  const dirty = body !== draft.body || (draft.channel === "email" && subject !== (draft.subject ?? ""));
  const saveIfChanged = () => {
    if (open && dirty && body.trim()) save.mutate();
  };
  const copy = async () => {
    await navigator.clipboard.writeText(draft.channel === "email" && subject ? `Subject: ${subject}\n\n${body}` : body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mt-3 rounded-md border bg-muted/40 p-3" data-testid="review-draft" onClick={(e) => e.stopPropagation()}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Draft {draft.channel === "email" ? "email" : "text"} to <span className="font-medium text-foreground">{draft.to}</span>
          {draft.edited && " · edited"}
          {save.isPending && " · saving…"}
          {save.isError && <span className="text-destructive"> · could not save</span>}
        </span>
        <Button size="sm" variant="outline" type="button" onClick={() => void copy()} data-testid="review-draft-copy">
          <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {draft.channel === "email" && (
        <Input aria-label="Subject" className="mb-2 h-8 bg-background" value={subject} disabled={!open} onChange={(e) => setSubject(e.target.value)} onBlur={saveIfChanged} />
      )}
      <Textarea aria-label="Draft" rows={Math.min(16, Math.max(3, body.split("\n").length + 1))} className="min-h-0 bg-background" value={body} disabled={!open} onChange={(e) => setBody(e.target.value)} onBlur={saveIfChanged} data-testid="review-draft-body" />
    </div>
  );
}

function describe(it: ReviewItem): string {
  if (it.itemType === "participant_match" && it.party) {
    return `${it.speakerLabel ?? "A speaker"} is probably ${it.party.name}${it.confidence != null ? ` (${it.confidence.toFixed(2)})` : ""}`;
  }
  const p = it.proposal;
  const who = typeof p.proposed_by === "string" && p.source === "mcp" ? ` · proposed by ${p.proposed_by} (agent)` : "";
  if (it.itemType === "new_fact" && typeof p.text === "string") {
    const extra = [typeof p.amount === "number" ? `$${p.amount.toLocaleString()}` : null, typeof p.due_date === "string" ? `due ${p.due_date}` : null].filter(Boolean).join(", ");
    return `New ${p.kind === "followup" ? "follow-up" : String(p.kind ?? "fact")}: ${p.text}${extra ? ` (${extra})` : ""}${who}`;
  }
  if (it.itemType === "new_party" && typeof p.name === "string") return `New ${String(p.kind ?? "party")}: ${p.name}${who}`;
  if (it.itemType === "party_edit" && it.party) return `Edit ${it.party.name}: ${Object.keys((p.changes as Record<string, unknown>) ?? {}).join(", ")}${who}`;
  if (it.itemType === "link_project_interaction") return `Link ${it.project?.name ?? `project #${String(p.project_id)}`} to this recording${who}`;
  if (it.itemType === "link_party_interaction" && it.party) return `Tag ${it.party.name} on this recording${it.speakerLabel ? ` as ${it.speakerLabel}` : ""}${who}`;
  if (it.itemType === "new_relationship") return `New relationship: #${String(p.from_party_id)} ${String(p.kind)} #${String(p.to_party_id)}${who}`;
  if (it.itemType === "workspace_assignment") return p.workspace_id ? `File this thread under ${String(p.workspace_id)}` : "Choose a workspace for this thread";
  if (it.itemType === "reply_needed") return p.no_reply_needed ? `No reply needed${it.party ? ` to ${it.party.name}` : ""}` : `Reply to ${it.party?.name ?? "this message"}`;
  if (it.itemType === "nudge") {
    const who = it.party?.name ?? "them";
    if (p.reason === "quiet") return `Check in with ${who}: no answer to your last message`;
    const what = typeof p.fact_text === "string" ? p.fact_text : "a commitment";
    return `${p.reason === "overdue" ? `Overdue${typeof p.due_date === "string" ? ` (due ${p.due_date})` : ""}` : "Still open"}: ${what}`;
  }
  if (it.itemType === "fact_status") return `Done? ${typeof p.fact_text === "string" ? p.fact_text : `commitment #${String(p.fact_id)}`}`;
  if (it.itemType === "interaction_workspace") return `File under ${String(p.workspace_id)}${typeof p.confidence === "number" ? ` (${Math.round(p.confidence * 100)}% sure)` : ""}`;
  return `${it.itemType.replace(/_/g, " ")} proposal${who}`;
}
