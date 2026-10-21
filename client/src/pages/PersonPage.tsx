import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, Globe, Mail, MapPin, Phone, User } from "lucide-react";
import { api } from "@/lib/api";
import { formatDate, formatDuration } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceIcon } from "@/components/SourceIcon";
import { StatusChip } from "@/components/StatusChip";
import { EmptyState } from "@/components/EmptyState";

interface PartyDetail {
  id: number;
  kind: string;
  name: string;
  emails: string[];
  phones: string[];
  location: string | null;
  website: string | null;
  notes: string | null;
  roles: Array<{ workspaceId: string; workspaceName: string; role: string; status: string; market: string | null; detail: string | null }>;
  affiliations: Array<{ id: number; title: string | null; isCurrent: boolean; other: { id: number; name: string; kind: string } }>;
  interactions: Array<{ id: number; title: string | null; occurredAt: string | null; durationSec: number | null; source: string | null; pipelineStatus: string | null }>;
}

/** Phase 1 person page: identity, roles and the recordings they were in. Phase 2 adds editing, facts and projects. */
export default function PersonPage() {
  const { id } = useParams();
  const pid = Number(id);
  const party = useQuery({ queryKey: ["party", pid], queryFn: () => api<PartyDetail>(`/parties/${pid}`), enabled: pid > 0 });
  useEffect(() => {
    document.title = `${party.data?.name ?? "Person"} · Strout Vault`;
  }, [party.data?.name]);

  if (party.isError) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <EmptyState title="Person not found" />
      </div>
    );
  }
  const p = party.data;
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {!p ? (
        <div className="space-y-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {p.kind === "org" ? <Building2 className="h-5 w-5" /> : <User className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{p.name}</h1>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {p.roles.map((r) => (
                  <Badge key={`${r.workspaceId}-${r.role}`} variant="muted" title={r.detail ?? undefined}>
                    {r.workspaceName} · {r.role}{r.market ? ` · ${r.market}` : ""}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <dl className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
            {p.emails.map((e) => (
              <div key={e} className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" /><a className="hover:underline" href={`mailto:${e}`}>{e}</a></div>
            ))}
            {p.phones.map((ph) => (
              <div key={ph} className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" /><a className="hover:underline tabular" href={`tel:${ph}`}>{ph}</a></div>
            ))}
            {p.location && <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-muted-foreground" />{p.location}</div>}
            {p.website && <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" /><a className="hover:underline" href={p.website} target="_blank" rel="noreferrer">{p.website.replace(/^https?:\/\//, "")}</a></div>}
          </dl>
          {p.affiliations.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium">{p.kind === "org" ? "People" : "Organizations"}</h2>
              <ul className="flex flex-wrap gap-2">
                {p.affiliations.map((a) => (
                  <li key={a.id}>
                    <Link to={`/p/${a.other.id}`} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent">
                      {a.other.kind === "org" ? <Building2 className="h-3.5 w-3.5 text-muted-foreground" /> : <User className="h-3.5 w-3.5 text-muted-foreground" />}
                      {a.other.name}{a.title && <span className="text-xs text-muted-foreground">· {a.title}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="mt-8">
            <h2 className="mb-2 text-sm font-medium">Recordings <span className="text-muted-foreground tabular">({p.interactions.length})</span></h2>
            {p.interactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not tagged on any recording yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {p.interactions.map((i) => (
                  <li key={i.id}>
                    <Link to={`/r/${i.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50">
                      <SourceIcon source={i.source} />
                      <span className="min-w-0 flex-1 truncate font-medium">{i.title?.trim() || "Untitled recording"}</span>
                      <StatusChip status={i.pipelineStatus} />
                      <span className="shrink-0 text-xs text-muted-foreground tabular">{formatDate(i.occurredAt)}{i.durationSec != null ? ` · ${formatDuration(i.durationSec)}` : ""}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
