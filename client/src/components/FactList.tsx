import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatTimestamp } from "@/lib/format";
import type { FactItem } from "@shared/types";

type Fact = FactItem & { interaction?: { id: number; title: string | null; occurredAt?: string | null } | null };

/** Facts with a link to the moment in the recording they were pulled from. */
export function FactList({ facts, emptyText = "No facts yet." }: { facts: Fact[]; emptyText?: string }) {
  if (!facts.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {facts.map((f) => {
        const to = f.interaction ? `/r/${f.interaction.id}${f.quoteStartSec != null ? `?t=${f.quoteStartSec}` : ""}` : null;
        const body = (
          <>
            <Badge variant={f.status === "open" ? "warning" : "muted"} className="shrink-0 self-start">{f.kind}</Badge>
            <span className="min-w-0 flex-1">
              {f.text}
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {f.interaction?.title && <span>{f.interaction.title}</span>}
                {f.interaction?.occurredAt && <span> · {formatDate(f.interaction.occurredAt)}</span>}
                {f.quoteStartSec != null && <span className="tabular"> · {formatTimestamp(f.quoteStartSec)}</span>}
                {f.ownerParty && <span> · {f.ownerParty.name}</span>}
                {f.dueDate && <span> · due {f.dueDate}</span>}
                {f.status && f.status !== "open" && <span> · {f.status}</span>}
              </span>
            </span>
          </>
        );
        return (
          <li key={f.id}>
            {to ? (
              <Link to={to} className="flex items-start gap-3 px-3 py-2 hover:bg-accent/50">{body}</Link>
            ) : (
              <div className="flex items-start gap-3 px-3 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
