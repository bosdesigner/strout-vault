import { Mic, Phone, PhoneForwarded, Upload, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { SOURCE_LABEL } from "@/lib/format";

export function SourceIcon({ source, className }: { source: string | null | undefined; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  const label = source ? SOURCE_LABEL[source] ?? source : "Recording";
  const icon =
    source === "zoom" || source === "meet" ? <Video className={cls} aria-hidden /> :
    source === "iphone_call" ? <Phone className={cls} aria-hidden /> :
    source === "contractor_call" ? <PhoneForwarded className={cls} aria-hidden /> :
    source === "upload" ? <Upload className={cls} aria-hidden /> :
    <Mic className={cls} aria-hidden />;
  return (
    <span className="inline-flex items-center text-muted-foreground" title={label} aria-label={label}>
      {icon}
    </span>
  );
}
