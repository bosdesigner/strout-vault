import { Loader2, Upload } from "lucide-react";
import { uploadStore, useUploads, uploadsInProgress } from "@/lib/uploads";

/** Compact progress pill while the dialog is closed and uploads are running. */
export function UploadTray() {
  const { items, dialogOpen } = useUploads();
  const busy = uploadsInProgress(items);
  if (dialogOpen || busy === 0) return null;
  const total = items.filter((i) => i.status !== "duplicate" && i.status !== "error").length;
  const done = items.filter((i) => i.status === "done").length;
  const pct = Math.round((items.filter((i) => i.status === "uploading").reduce((a, i) => a + i.progress, 0) + done) / Math.max(1, total) * 100);
  return (
    <button
      type="button"
      onClick={() => uploadStore.openDialog()}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-full border bg-card px-4 py-2 text-sm shadow-lg hover:bg-accent safe-bottom"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span>
        Uploading {busy} file{busy === 1 ? "" : "s"} · <span className="tabular">{pct}%</span>
      </span>
      <Upload className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}
