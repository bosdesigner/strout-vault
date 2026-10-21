import { useCallback, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Inbox, Upload } from "lucide-react";
import { api } from "@/lib/api";
import type { LibraryPage as LibraryPageData } from "@shared/types";
import { LibraryFilters, readFilters } from "@/components/LibraryFilters";
import { RecordingCard, RecordingCardSkeleton } from "@/components/RecordingCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { uploadStore } from "@/lib/uploads";
import { useWindowDropzone } from "@/hooks/useDropzone";
import { isReady } from "@/lib/format";

const PAGE = 24;

export default function LibraryPage() {
  const [params] = useSearchParams();
  const f = readFilters(params);
  const qc = useQueryClient();

  useEffect(() => {
    document.title = "Library · Strout Vault";
  }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    if (f.source) p.set("source", f.source);
    if (f.workspace) p.set("workspace", f.workspace);
    if (f.party) p.set("party", String(f.party.id));
    if (f.hasVideo) p.set("hasVideo", "true");
    p.set("limit", String(PAGE));
    return p.toString();
  }, [f.from, f.to, f.source, f.workspace, f.party?.id, f.hasVideo]);

  const query = useInfiniteQuery({
    queryKey: ["library", queryString],
    queryFn: ({ pageParam }) => api<LibraryPageData>(`/interactions?${queryString}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  // Refresh anything still in the pipeline every 10 seconds.
  const pendingIds = items.filter((i) => !isReady(i.pipelineStatus)).map((i) => i.id);
  useQuery({
    queryKey: ["library-status", pendingIds.join(",")],
    enabled: pendingIds.length > 0,
    refetchInterval: 10_000,
    queryFn: async () => {
      const out = await api<{ items: Array<{ id: number; pipelineStatus: string | null; pipelineError: string | null; durationSec: number | null; title: string | null }> }>(
        `/interactions/status?ids=${pendingIds.join(",")}`,
      );
      const byId = new Map(out.items.map((s) => [s.id, s]));
      qc.setQueryData<typeof query.data>(["library", queryString], (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((pg) => ({
                ...pg,
                items: pg.items.map((it) => {
                  const s = byId.get(it.id);
                  return s ? { ...it, pipelineStatus: s.pipelineStatus as typeof it.pipelineStatus, durationSec: s.durationSec ?? it.durationSec, title: s.title ?? it.title } : it;
                }),
              })),
            }
          : old,
      );
      return out;
    },
  });

  // Infinite scroll.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage, query]);

  const onFiles = useCallback((files: File[]) => {
    uploadStore.addFiles(files, { workspaceId: f.workspace || null });
  }, [f.workspace]);
  const dragging = useWindowDropzone(onFiles);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary bg-card px-10 py-8 text-center shadow-lg">
            <Upload className="mx-auto h-8 w-8 text-primary" />
            <p className="mt-3 text-base font-medium">Drop to add to the vault</p>
            <p className="text-sm text-muted-foreground">MP4, MOV, M4A, MP3, WAV, WEBM, MKV</p>
          </div>
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">Every recorded conversation, newest first.</p>
        </div>
      </div>
      <div className="mb-6">
        <LibraryFilters />
      </div>

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="Loading recordings">
          {Array.from({ length: 12 }).map((_, i) => (
            <RecordingCardSkeleton key={i} />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState title="Could not load the library">{(query.error as Error).message}</EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title={params.toString() ? "No recordings match these filters" : "The vault is empty"}
          action={
            params.toString() ? undefined : (
              <Button onClick={() => uploadStore.openDialog()}>
                <Upload /> Upload a recording
              </Button>
            )
          }
        >
          {params.toString() ? "Try widening the date range or clearing a filter." : "Drop a video or audio file anywhere on this page, or use the Upload button."}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="library-grid">
            {items.map((it) => (
              <RecordingCard key={it.id} item={it} />
            ))}
            {query.isFetchingNextPage && Array.from({ length: 4 }).map((_, i) => <RecordingCardSkeleton key={`s${i}`} />)}
          </div>
          <div ref={sentinel} className="h-1" />
          {!query.hasNextPage && items.length >= PAGE && <p className="py-8 text-center text-xs text-muted-foreground">That's everything.</p>}
        </>
      )}
    </div>
  );
}
