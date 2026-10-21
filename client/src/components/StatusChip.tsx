import { Badge } from "@/components/ui/badge";
import { isReady, statusLabel } from "@/lib/format";
import { Loader2 } from "lucide-react";

/** Pipeline status chip; renders nothing when the recording is ready. */
export function StatusChip({ status, error, always = false }: { status: string | null | undefined; error?: string | null; always?: boolean }) {
  if (isReady(status) && !always) return null;
  if (isReady(status)) return <Badge variant="success">Ready</Badge>;
  if (status === "failed") {
    return (
      <Badge variant="destructive" title={error ?? undefined}>
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1" data-status={status}>
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      {statusLabel(status)}
    </Badge>
  );
}
