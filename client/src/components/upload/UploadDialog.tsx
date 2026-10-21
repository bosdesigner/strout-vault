import { useRef } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Copy, FileVideo, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PartyPicker } from "@/components/PartyPicker";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { ACCEPT_ATTR, uploadStore, useUploads, type UploadItem, type UploadSource } from "@/lib/uploads";
import { formatBytes } from "@/lib/format";

const NONE = "__none";
const SOURCES: Array<{ value: UploadSource; label: string }> = [
  { value: "upload", label: "Upload" },
  { value: "iphone_call", label: "Phone call" },
  { value: "contractor_call", label: "Contractor call" },
];

export function UploadDialog() {
  const { items, dialogOpen } = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const workspaces = useWorkspaces();
  const ready = items.filter((i) => i.status === "ready").length;
  const hashing = items.filter((i) => i.status === "hashing").length;

  return (
    <Dialog open={dialogOpen} onOpenChange={(o) => (o ? uploadStore.openDialog() : uploadStore.closeDialog())}>
      <DialogContent className="max-w-2xl p-0 gap-0" aria-describedby="upload-desc">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Upload recordings</DialogTitle>
          <DialogDescription id="upload-desc">
            Files go straight to storage and are transcribed in the background. MP4, MOV, M4A, MP3, WAV, WEBM or MKV.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-4 space-y-3 max-h-[60dvh] overflow-y-auto">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="sr-only"
            data-testid="file-input"
            aria-label="Choose files"
            onChange={(e) => {
              if (e.target.files?.length) uploadStore.addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {items.length === 0 ? (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center hover:border-primary hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <span className="mt-3 text-sm font-medium">Choose files</span>
              <span className="mt-1 text-xs text-muted-foreground">or drop them anywhere on the library page</span>
            </button>
          ) : (
            <ul className="space-y-3">
              {items.map((it) => (
                <UploadRow key={it.id} item={it} workspaces={workspaces.data ?? []} />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="border-t px-5 py-3 sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Plus /> Add files
            </Button>
            {items.some((i) => ["done", "duplicate", "error"].includes(i.status)) && (
              <Button type="button" variant="ghost" size="sm" onClick={() => uploadStore.clearFinished()}>
                Clear finished
              </Button>
            )}
          </div>
          <Button type="button" onClick={() => uploadStore.start()} disabled={ready === 0} data-testid="start-upload">
            {hashing > 0 && ready === 0 ? (
              <>
                <Loader2 className="animate-spin" /> Checking files…
              </>
            ) : (
              <>
                <Upload /> Upload {ready > 0 ? `${ready} file${ready === 1 ? "" : "s"}` : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadRow({ item, workspaces }: { item: UploadItem; workspaces: Array<{ id: string; name: string }> }) {
  const editable = item.status === "ready" || item.status === "hashing";
  const pct = Math.round(item.progress * 100);
  return (
    <li className="rounded-lg border p-3" data-testid="upload-row" data-status={item.status}>
      <div className="flex items-start gap-3">
        <FileVideo className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{item.name}</p>
            <span className="shrink-0 text-xs text-muted-foreground tabular">{formatBytes(item.size)}</span>
          </div>
          <StatusLine item={item} pct={pct} />
        </div>
        {item.status !== "uploading" && item.status !== "finishing" && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${item.name}`} onClick={() => uploadStore.remove(item.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {(item.status === "uploading" || item.status === "hashing" || item.status === "finishing") && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${item.name} progress`}>
          <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${item.status === "hashing" ? Math.max(2, pct) : Math.max(2, pct)}%` }} />
        </div>
      )}
      {editable && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`t-${item.id}`} className="text-xs text-muted-foreground">Title</Label>
            <Input id={`t-${item.id}`} value={item.title} onChange={(e) => uploadStore.update(item.id, { title: e.target.value })} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`d-${item.id}`} className="text-xs text-muted-foreground">Recorded</Label>
            <Input id={`d-${item.id}`} type="datetime-local" value={item.recordedAt} onChange={(e) => uploadStore.update(item.id, { recordedAt: e.target.value })} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`s-${item.id}`} className="text-xs text-muted-foreground">Source</Label>
            <Select value={item.source} onValueChange={(v) => uploadStore.update(item.id, { source: v as UploadSource })}>
              <SelectTrigger id={`s-${item.id}`} className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`w-${item.id}`} className="text-xs text-muted-foreground">Workspace</Label>
            <Select value={item.workspaceId ?? NONE} onValueChange={(v) => uploadStore.update(item.id, { workspaceId: v === NONE ? null : v })}>
              <SelectTrigger id={`w-${item.id}`} className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`p-${item.id}`} className="text-xs text-muted-foreground">People</Label>
            <PartyPicker id={`p-${item.id}`} value={item.people} onChange={(people) => uploadStore.update(item.id, { people })} />
          </div>
        </div>
      )}
    </li>
  );
}

function StatusLine({ item, pct }: { item: UploadItem; pct: number }) {
  const cls = "mt-0.5 flex items-center gap-1.5 text-xs";
  switch (item.status) {
    case "hashing":
      return <p className={`${cls} text-muted-foreground`}><Loader2 className="h-3 w-3 animate-spin" /> Checking for duplicates… {pct > 0 && <span className="tabular">{pct}%</span>}</p>;
    case "duplicate":
      return (
        <p className={`${cls} text-amber-700 dark:text-amber-300`} data-testid="duplicate-notice">
          <Copy className="h-3 w-3" /> Already in the vault:{" "}
          {item.duplicate?.interactionId ? (
            <Link to={`/r/${item.duplicate.interactionId}`} className="underline underline-offset-2" onClick={() => uploadStore.closeDialog()}>
              {item.duplicate.title || "open recording"}
            </Link>
          ) : (
            <span>{item.duplicate?.title || "an existing file"}</span>
          )}
        </p>
      );
    case "ready":
      return <p className={`${cls} text-muted-foreground`}>Ready to upload</p>;
    case "uploading":
      return <p className={`${cls} text-muted-foreground`}><Loader2 className="h-3 w-3 animate-spin" /> Uploading <span className="tabular">{pct}%</span></p>;
    case "finishing":
      return <p className={`${cls} text-muted-foreground`}><Loader2 className="h-3 w-3 animate-spin" /> Saving…</p>;
    case "done":
      return (
        <p className={`${cls} text-emerald-700 dark:text-emerald-300`} data-testid="upload-done">
          <CheckCircle2 className="h-3 w-3" /> Added to the vault.{" "}
          {item.interactionId && (
            <Link to={`/r/${item.interactionId}`} className="underline underline-offset-2" onClick={() => uploadStore.closeDialog()}>
              Open
            </Link>
          )}
        </p>
      );
    case "error":
      return (
        <p className={`${cls} text-destructive`}>
          <AlertCircle className="h-3 w-3" /> {item.error}{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => uploadStore.retry(item.id)}>Retry</button>
        </p>
      );
  }
}
