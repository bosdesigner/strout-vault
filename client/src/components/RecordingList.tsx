import { Link } from "react-router-dom";
import { SourceIcon } from "./SourceIcon";
import { StatusChip } from "./StatusChip";
import { formatDate, formatDuration } from "@/lib/format";

interface Item {
  id: number;
  title: string | null;
  occurredAt: string | null;
  durationSec: number | null;
  source: string | null;
  pipelineStatus: string | null;
  speakerLabel?: string | null;
}

/** Compact timeline of recordings, newest first. */
export function RecordingList({ items, emptyText = "No recordings yet." }: { items: Item[]; emptyText?: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={`/r/${i.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50">
            <SourceIcon source={i.source} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{i.title?.trim() || "Untitled recording"}</span>
              {i.speakerLabel && <span className="block text-xs text-muted-foreground">as {i.speakerLabel}</span>}
            </span>
            <StatusChip status={i.pipelineStatus} />
            <span className="shrink-0 text-xs text-muted-foreground tabular">
              {formatDate(i.occurredAt)}
              {i.durationSec != null ? ` · ${formatDuration(i.durationSec)}` : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
