import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type SourceStatus = "live" | "never_run" | "not_configured" | "erroring";

interface SourceRow {
  id: string;
  label: string;
  detail: string | null;
  status: SourceStatus;
  warning: string | null;
  lastSuccessAt: string | null;
  lastSeenAt: string | null;
  items24h: number;
  items7d: number;
  total: number;
  lastError: string | null;
  note: string | null;
}

const STATUS: Record<SourceStatus, { label: string; variant: "success" | "muted" | "warning" | "destructive" }> = {
  live: { label: "live", variant: "success" },
  never_run: { label: "configured, never run", variant: "warning" },
  not_configured: { label: "not configured", variant: "muted" },
  erroring: { label: "erroring", variant: "destructive" },
};

/** Every ingest point's health, read from the tables each one writes (GET /api/pipeline/sources). */
export function SourcesPanel() {
  const q = useQuery({ queryKey: ["pipeline-sources"], queryFn: () => api<{ generatedAt: string; rows: SourceRow[] }>("/pipeline/sources"), refetchInterval: 60_000 });
  return (
    <section aria-label="Sources" className="mb-8" data-testid="sources-panel">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Sources</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Every way a conversation reaches the vault, from what each one actually wrote. Items are counted when they arrived.</p>
        </div>
        {q.data && <span className="text-xs text-muted-foreground">checked {formatRelative(q.data.generatedAt)}</span>}
      </div>
      {q.isLoading || !q.data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="hidden w-full text-sm md:table">
            <thead className="whitespace-nowrap bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Last success</th>
                <th className="px-3 py-2 text-right font-medium">24 h</th>
                <th className="px-3 py-2 text-right font-medium">7 d</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.rows.map((r) => (
                <tr key={r.id} data-testid={`source-${r.id}`} data-status={r.status} className="align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.label}</div>
                    {r.detail && <div className="text-xs text-muted-foreground">{r.detail}</div>}
                    {r.note && <div className="text-xs text-muted-foreground">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge r={r} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.lastSuccessAt ? formatRelative(r.lastSuccessAt) : "never"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.items24h}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.items7d}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total}</td>
                  <td className="max-w-[16rem] px-3 py-2 text-xs text-destructive">{r.lastError ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y md:hidden">
            {q.data.rows.map((r) => (
              <li key={r.id} className="space-y-1 p-3 text-sm" data-status={r.status}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{r.label}</div>
                    {r.detail && <div className="truncate text-xs text-muted-foreground">{r.detail}</div>}
                  </div>
                  <StatusBadge r={r} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.items24h} in 24 h · {r.items7d} in 7 d · {r.total} total · last success {r.lastSuccessAt ? formatRelative(r.lastSuccessAt) : "never"}
                </p>
                {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
                {r.lastError && <p className="text-xs text-destructive">{r.lastError}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ r }: { r: SourceRow }) {
  const s = STATUS[r.status];
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Badge variant={s.variant}>{s.label}</Badge>
      {r.warning && (
        <span className="inline-flex max-w-[14rem] items-start gap-1 text-xs text-amber-700 dark:text-amber-300" title={r.warning}>
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {r.warning}
        </span>
      )}
    </span>
  );
}
