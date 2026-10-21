import { Link } from "react-router-dom";
import { Clock, Film, Users } from "lucide-react";
import type { LibraryCard } from "@shared/types";
import { formatDate, formatDuration, isGenericTitle } from "@/lib/format";
import { SourceIcon } from "./SourceIcon";
import { StatusChip } from "./StatusChip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function RecordingCard({ item }: { item: LibraryCard }) {
  const generic = isGenericTitle(item.title);
  const title = item.title?.trim() || "Untitled recording";
  const names = item.participants.map((p) => p.name);
  const extra = item.participantCount - names.length;
  return (
    <Link
      to={`/r/${item.id}`}
      data-testid="recording-card"
      data-id={item.id}
      data-date={item.occurredAt ?? ""}
      className={cn(
        "group flex h-full flex-col rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-2">
        <SourceIcon source={item.source} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 className={cn("line-clamp-2 text-sm font-medium leading-snug", generic && "text-muted-foreground font-normal")}>{title}</h3>
          {generic && item.preview && <p className="mt-1 line-clamp-2 text-sm leading-snug text-foreground">{item.preview}</p>}
        </div>
        {item.hasVideo && <Film className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-label="Video available" />}
      </div>
      <div className="mt-auto pt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <time dateTime={item.occurredAt ?? undefined} className="tabular">{formatDate(item.occurredAt) || "Undated"}</time>
        {item.durationSec != null && (
          <span className="inline-flex items-center gap-1 tabular">
            <Clock className="h-3 w-3" aria-hidden />
            {formatDuration(item.durationSec)}
          </span>
        )}
        <StatusChip status={item.pipelineStatus} />
      </div>
      {names.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <Users className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {names.join(", ")}
            {extra > 0 && ` +${extra}`}
          </span>
        </p>
      )}
    </Link>
  );
}

export function RecordingCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 flex-1" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <div className="flex gap-3 pt-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}
