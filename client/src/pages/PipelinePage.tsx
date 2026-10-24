import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { formatDate, formatRelative, SOURCE_LABEL } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/StatusChip";

interface Run {
  id: number;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  trigger: string;
  durationSec: number | null;
  lines: string[];
  errors: string[];
  skipped: string | null;
}
interface Item {
  id: number;
  title: string | null;
  occurredAt: string | null;
  source: string | null;
  error?: string | null;
  note?: string | null;
  status?: string | null;
  pendingFiles?: number;
  failedFiles?: number;
  fileError?: string | null;
  updatedAt: string | null;
}
interface Overview {
  report: {
    queue: { queued: number; transcribing: number; failed: number; ready: number };
    downloads: { pending: number; failed: number };
    missingOffsite: { total: number; items: Array<{ id: number; title: string | null; occurredAt: string | null; source: string | null }> };
    spend: { month: string; groqUsd: number };
  };
  lastRuns: Run[];
  failed: Item[];
  waiting: Item[];
  config: {
    zoomConfigured: boolean;
    groqConfigured: boolean;
    groqBudgetUsd: number;
    groqModel: string;
    transcribePrefer: string;
    archiveStorage: string;
    archiveBucket: string | null;
    overlapMonths: number;
  };
  state: { zoomCursor: string | null; lastRun: { id: number; ok: boolean; finishedAt: string } | null };
  embeddings: {
    embedded: number;
    pending: number;
    failed: number;
    noTranscript: number;
    chunks: number;
    lastEmbeddedAt: string | null;
    provider: { name: string; model: string } | null;
    workerProvider: string | null;
  } | null;
}

/** Owner only: what the hourly worker did, what is waiting, and why. */
export default function PipelinePage() {
  const qc = useQueryClient();
  useEffect(() => {
    document.title = "Pipeline · Strout Vault";
  }, []);
  const q = useQuery({ queryKey: ["pipeline"], queryFn: () => api<Overview>("/pipeline"), refetchInterval: 60_000 });
  const retry = useMutation({
    mutationFn: (interactionId: number) => api("/pipeline/retry", { method: "POST", json: { interactionId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline"] });
      qc.invalidateQueries({ queryKey: ["library"] });
    },
  });

  if (q.isLoading || !q.data) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
        <Skeleton className="h-8 w-40" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </main>
    );
  }
  const d = q.data;
  const last = d.lastRuns[0];
  const r = d.report;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 pb-24 lg:pb-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The worker runs every hour: it pulls new Zoom recordings into storage, transcribes what is waiting, and reports here. Nothing is ever deleted.
        </p>
      </header>

      <section aria-label="Status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Last run" icon={last?.ok === false ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}>
          {last ? (
            <>
              <p className="text-lg font-medium">{formatRelative(last.finishedAt ?? last.startedAt)}</p>
              <p className="text-xs text-muted-foreground">
                {last.skipped ? `skipped (${last.skipped})` : last.ok ? "completed" : "finished with errors"}
                {last.durationSec != null ? ` · ${last.durationSec}s` : ""}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No runs yet. Deploy the worker (see the README) and check back in an hour.</p>
          )}
        </Card>
        <Card title="Queue" icon={<Clock className="h-4 w-4 text-muted-foreground" />}>
          <p className="text-lg font-medium" data-testid="queue-counts">
            {r.queue.queued} queued · {r.queue.transcribing} transcribing
          </p>
          <p className="text-xs text-muted-foreground">
            {r.queue.failed} failed · {r.queue.ready} ready · {r.downloads.pending + r.downloads.failed} download{r.downloads.pending + r.downloads.failed === 1 ? "" : "s"} pending
          </p>
        </Card>
        <Card title="Transcription spend">
          <p className="text-lg font-medium">${r.spend.groqUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">
            {d.config.groqConfigured ? `of $${d.config.groqBudgetUsd.toFixed(2)} Groq budget for ${r.spend.month}` : "Groq is off: Zoom transcripts only"}
          </p>
        </Card>
        <Card title="Sources">
          <ul className="space-y-1 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span>Zoom</span>
              {d.config.zoomConfigured ? <Badge variant="success">on{d.state.zoomCursor ? ` · synced to ${d.state.zoomCursor}` : ""}</Badge> : <Badge variant="warning">not configured</Badge>}
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>Archive</span>
              <span className="text-muted-foreground">{d.config.archiveStorage.toUpperCase()}{d.config.archiveBucket ? ` · ${d.config.archiveBucket}` : ""}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>Transcripts</span>
              <span className="text-muted-foreground">{d.config.transcribePrefer === "zoom" ? "Zoom first, then Groq" : "Groq first"}</span>
            </li>
          </ul>
        </Card>
      </section>

      {d.embeddings && (
        <section aria-label="Semantic index" className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Semantic index">
            <p className="text-lg font-medium" data-testid="embedding-counts">
              {d.embeddings.embedded} embedded · {d.embeddings.pending} pending
            </p>
            <p className="text-xs text-muted-foreground">
              {d.embeddings.failed} failed · {d.embeddings.noTranscript} without a transcript · {d.embeddings.chunks} chunks
              {d.embeddings.lastEmbeddedAt ? ` · last ${formatRelative(d.embeddings.lastEmbeddedAt)}` : ""}
            </p>
          </Card>
          <Card title="Embedding provider">
            <p className="text-sm">
              {d.embeddings.workerProvider && d.embeddings.workerProvider !== "off"
                ? `worker: ${d.embeddings.workerProvider}`
                : d.embeddings.provider
                  ? `${d.embeddings.provider.name} ${d.embeddings.provider.model}`
                  : "off: search is keyword-only"}
            </p>
            <p className="text-xs text-muted-foreground">New transcripts are embedded by the hourly worker; the backlog by <code>npm run embed:backfill</code>. Agents search them at <Link to="/agents" className="underline">Agents &amp; API</Link>.</p>
          </Card>
        </section>
      )}

      {d.failed.length > 0 && (
        <Section title={`Failed (${d.failed.length})`} description="The last attempt did not finish. Retry puts the recording back in the queue for the next run.">
          <ul className="divide-y rounded-lg border">
            {d.failed.map((it) => (
              <li key={it.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="failed-item">
                <div className="min-w-0">
                  <Link to={`/r/${it.id}`} className="font-medium hover:underline">
                    {it.title || `Recording #${it.id}`}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {[SOURCE_LABEL[it.source ?? ""] ?? it.source, formatDate(it.occurredAt), it.updatedAt ? `failed ${formatRelative(it.updatedAt)}` : null].filter(Boolean).join(" · ")}
                  </p>
                  {it.error && <p className="mt-1 break-words text-xs text-destructive">{it.error}</p>}
                </div>
                <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => retry.mutate(it.id)} disabled={retry.isPending}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Waiting (${d.waiting.length})`} description="Queued or in progress. A note explains anything the worker is holding back on.">
        {d.waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {d.waiting.map((it) => (
              <li key={it.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="waiting-item">
                <div className="min-w-0">
                  <Link to={`/r/${it.id}`} className="font-medium hover:underline">
                    {it.title || `Recording #${it.id}`}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {[SOURCE_LABEL[it.source ?? ""] ?? it.source, formatDate(it.occurredAt), it.pendingFiles ? `${it.pendingFiles} file(s) still downloading` : null].filter(Boolean).join(" · ")}
                  </p>
                  {it.note && <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-400">{it.note}</p>}
                  {it.failedFiles ? (
                    <p className="mt-1 break-words text-xs text-destructive">
                      {it.failedFiles} download{it.failedFiles === 1 ? "" : "s"} failed{it.fileError ? `: ${it.fileError}` : ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {it.failedFiles ? (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => retry.mutate(it.id)} disabled={retry.isPending} data-testid="retry-downloads">
                      <RefreshCw className="h-3.5 w-3.5" /> Retry downloads
                    </Button>
                  ) : null}
                  <StatusChip status={it.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent runs">
        {d.lastRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {d.lastRuns.map((run) => (
              <li key={run.id} className="rounded-lg border p-3" data-testid="run">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {run.skipped ? <Badge variant="secondary">skipped</Badge> : run.ok ? <Badge variant="success">ok</Badge> : <Badge variant="destructive">errors</Badge>}
                  <span className="font-medium">{formatDate(run.startedAt, { withTime: true })}</span>
                  <span className="text-muted-foreground">
                    {run.trigger}
                    {run.durationSec != null ? ` · ${run.durationSec}s` : ""}
                  </span>
                </div>
                {run.lines.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                    {run.lines.map((l, i) => (
                      <li key={i} className={l.startsWith("errors:") ? "text-destructive" : undefined}>
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Without an off-site copy (${r.missingOffsite.total})`}
        description="Recordings with no verified audio or video in B2 or R2. Anything listed here would be lost if the Mac drive went away."
      >
        {r.missingOffsite.total === 0 ? (
          <p className="text-sm text-muted-foreground">Every recording has a verified off-site copy.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {r.missingOffsite.items.map((it) => (
              <li key={it.id} className="p-3 text-sm">
                <Link to={`/r/${it.id}`} className="font-medium hover:underline">
                  {it.title || `Recording #${it.id}`}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">{[SOURCE_LABEL[it.source ?? ""] ?? it.source, formatDate(it.occurredAt)].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}

function Card({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
        {icon}
      </div>
      {children}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mb-3 mt-0.5 text-sm text-muted-foreground">{description}</p>}
      {!description && <div className="mb-3" />}
      {children}
    </section>
  );
}
