import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, ExternalLink, RefreshCw, Scissors, X } from "lucide-react";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { formatBytes, formatDate, formatDuration, formatRelative, formatTimestamp, SOURCE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";

type Tab = "new" | "approved" | "cut";

interface ClipItem {
  id: number;
  interactionId: number;
  title: string | null;
  occurredAt: string | null;
  source: string | null;
  workspaceId: string | null;
  startSec: number;
  endSec: number;
  score: number;
  hook: string | null;
  why: string | null;
  platforms: string[];
  status: string;
  model: string | null;
  approvedAt: string | null;
  renderedAt: string | null;
  renderAttempts: number;
  renderError: string | null;
  clipMediaId: number | null;
  clipPath: string | null;
  clipBytes: number | null;
  clipDurationSec: number | null;
}
interface ClipList {
  items: ClipItem[];
  counts: Record<string, number>;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "new", label: "To review" },
  { id: "approved", label: "Approved" },
  { id: "cut", label: "Finished" },
];

/** Owner only: review Claude's clip candidates, watch approved ones render, download finished clips. */
export default function ClipsPage() {
  const { param } = useWorkspace();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("new");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    document.title = "Clips · Strout Vault";
  }, []);

  const list = useQuery({
    queryKey: ["clips", tab, param],
    queryFn: () => api<ClipList>(`/clips?status=${tab}${param ? `&${param.replace(/^[?&]/, "")}` : ""}`),
    placeholderData: (prev) => prev,
    refetchInterval: tab === "approved" ? 60_000 : false,
  });
  const items = list.data?.items ?? [];
  const counts = list.data?.counts ?? {};

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "approved" | "rejected" | "new" }) => api<{ id: number; status: string }>(`/clips/${id}`, { method: "PATCH", json: { status } }),
    onSuccess: (out) => {
      qc.setQueryData<ClipList>(["clips", tab, param], (old) => {
        if (!old) return old;
        const items = old.items.filter((i) => i.id !== out.id);
        const counts = { ...old.counts, [tab]: Math.max(0, (old.counts[tab] ?? 1) - 1), [out.status]: (old.counts[out.status] ?? 0) + 1 };
        return { items, counts };
      });
      void qc.invalidateQueries({ queryKey: ["clips"] });
    },
  });
  const rerender = useMutation({
    mutationFn: (id: number) => api(`/clips/${id}/rerender`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clips"] }),
  });
  const download = useMutation({
    mutationFn: (id: number) => api<{ url: string; filename: string }>(`/clips/${id}/download`),
    onSuccess: ({ url }) => {
      window.open(url, "_blank", "noopener");
    },
  });

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const act = useCallback(
    (status: "approved" | "rejected") => {
      const it = items[selected];
      if (!it || tab !== "new" || decide.isPending) return;
      decide.mutate({ id: it.id, status });
    },
    [items, selected, tab, decide],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "j") setSelected((s) => Math.min(s + 1, items.length - 1));
      else if (e.key === "k") setSelected((s) => Math.max(s - 1, 0));
      else if (e.key === "a") act("approved");
      else if (e.key === "r" || e.key === "x") act("rejected");
      else if (e.key === "o") {
        const it = items[selected];
        if (it) window.location.assign(`/r/${it.interactionId}?t=${Math.floor(it.startSec)}`);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected, act]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 pb-24 lg:pb-10">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clips</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Claude reads new transcripts for moments that could travel. Approve the ones you like; the worker renders them as 9:16 captioned video within the hour.
          </p>
        </div>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Keys: <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd> move · <kbd className="rounded border px-1">a</kbd> approve · <kbd className="rounded border px-1">r</kbd> skip · <kbd className="rounded border px-1">o</kbd> open
        </p>
      </header>

      <div role="tablist" aria-label="Clip status" className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setSelected(0);
            }}
            className={cn("flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors", tab === t.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            data-testid={`clips-tab-${t.id}`}
          >
            {t.label}
            {counts[t.id] != null && <span className="ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      {list.isLoading && !list.data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Scissors className="h-6 w-6" />}
          title={tab === "new" ? "Nothing to review" : tab === "approved" ? "Nothing waiting to render" : "No finished clips yet"}
        >
          {tab === "new" ? "New candidates appear here after the worker scouts a transcript." : tab === "approved" ? "Approve a candidate and the worker renders it on its next hourly run." : "Approved clips show up here once rendered, with a download button."}
        </EmptyState>
      ) : (
        <ol ref={listRef} className="space-y-3" aria-label="Clip candidates">
          {items.map((it, index) => (
            <li
              key={it.id}
              data-index={index}
              data-testid="clip-item"
              data-status={it.status}
              onClick={() => setSelected(index)}
              className={cn("rounded-lg border bg-card p-4 transition-colors", tab === "new" && index === selected && "ring-2 ring-ring")}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={it.score >= 8 ? "success" : it.score >= 6 ? "default" : "outline"} className="tabular">
                      score {it.score}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular">
                      {formatTimestamp(it.startSec)}–{formatTimestamp(it.endSec)} · {formatDuration(it.endSec - it.startSec)}
                    </span>
                    {it.platforms.map((p) => (
                      <span key={p} className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                        {p}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-base font-medium leading-snug">“{it.hook || "Clip"}”</p>
                  {it.why && <p className="mt-1 text-sm text-muted-foreground">{it.why}</p>}
                  <p className="mt-2 text-xs text-muted-foreground">
                    <Link to={`/r/${it.interactionId}?t=${Math.floor(it.startSec)}`} className="font-medium text-foreground hover:underline">
                      {it.title || `Recording #${it.interactionId}`}
                    </Link>
                    {" · "}
                    {[SOURCE_LABEL[it.source ?? ""] ?? it.source, formatDate(it.occurredAt)].filter(Boolean).join(" · ")}
                  </p>
                  {tab === "approved" && (
                    <p className={cn("mt-2 text-xs", it.renderError ? "text-destructive" : "text-muted-foreground")}>
                      {it.renderError
                        ? `Render failed${it.renderAttempts >= 3 ? " (gave up after 3 tries)" : ` (${it.renderAttempts} of 3 tries)`}: ${it.renderError}`
                        : `Approved ${formatRelative(it.approvedAt)}; the worker renders it on its next run.`}
                    </p>
                  )}
                  {tab === "cut" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {it.clipMediaId
                        ? `Rendered ${formatRelative(it.renderedAt)}${it.clipBytes ? ` · ${formatBytes(it.clipBytes)}` : ""}${it.clipDurationSec ? ` · ${formatDuration(it.clipDurationSec)}` : ""}`
                        : "Cut by meeting-vault on the Mac; the file is in the Movies folder there, not in the vault."}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  {tab === "new" && (
                    <>
                      <Button size="sm" onClick={() => decide.mutate({ id: it.id, status: "approved" })} disabled={decide.isPending} data-testid="approve">
                        <Check className="h-4 w-4" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: it.id, status: "rejected" })} disabled={decide.isPending} data-testid="skip">
                        <X className="h-4 w-4" /> Skip
                      </Button>
                    </>
                  )}
                  {tab === "approved" && (
                    <>
                      {it.renderError && (
                        <Button size="sm" variant="outline" onClick={() => rerender.mutate(it.id)} disabled={rerender.isPending} data-testid="rerender">
                          <RefreshCw className="h-3.5 w-3.5" /> Try again
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: it.id, status: "rejected" })} disabled={decide.isPending}>
                        <X className="h-4 w-4" /> Skip
                      </Button>
                    </>
                  )}
                  {tab === "cut" && it.clipMediaId && (
                    <Button size="sm" onClick={() => download.mutate(it.id)} disabled={download.isPending} data-testid="download">
                      <Download className="h-4 w-4" /> Download
                    </Button>
                  )}
                  <Button asChild size="sm" variant="ghost" aria-label="Open the moment in the recording">
                    <Link to={`/r/${it.interactionId}?t=${Math.floor(it.startSec)}`}>
                      <ExternalLink className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
