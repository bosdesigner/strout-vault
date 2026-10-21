// Upload manager: a small store outside React so uploads keep going when the
// dialog closes. Files go straight from the browser to storage with presigned
// multipart URLs (Uppy AwsS3); Express only hands out URLs and writes rows.
import { useSyncExternalStore } from "react";
import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import { api, ApiError, queryClient } from "./api";
import { sha256File } from "./sha256";
import { titleFromFilename, toLocalDateInput } from "./format";
import { ACCEPTED_UPLOAD_EXTENSIONS, type ParticipantRef, type UploadFinishInput } from "@shared/types";

export type UploadSource = "upload" | "iphone_call" | "contractor_call";
export type UploadStatus = "hashing" | "duplicate" | "ready" | "uploading" | "finishing" | "done" | "error";

export interface UploadItem {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  title: string;
  /** Local datetime string for <input type="datetime-local">. */
  recordedAt: string;
  workspaceId: string | null;
  people: ParticipantRef[];
  source: UploadSource;
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  sha256: string | null;
  duplicate: { interactionId: number | null; title: string | null } | null;
  interactionId: number | null;
  error: string | null;
  uppyId?: string;
}

interface State {
  items: UploadItem[];
  dialogOpen: boolean;
}

let state: State = { items: [], dialogOpen: false };
const subs = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((fn) => fn());
}
function updateItem(id: string, patch: Partial<UploadItem> | ((it: UploadItem) => Partial<UploadItem>)) {
  set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...(typeof patch === "function" ? patch(it) : patch) } : it)) }));
}

export function isAcceptedFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return (ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

export const ACCEPT_ATTR = ACCEPTED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",") + ",video/*,audio/*";

let uppy: Uppy | null = null;
/** Storage key per upload item, captured when the multipart upload is created. */
const keyByItem = new Map<string, string>();
function itemIdOf(file: { meta?: Record<string, unknown> } | undefined): string | undefined {
  const v = file?.meta?.itemId;
  return typeof v === "string" ? v : undefined;
}
function getUppy(): Uppy {
  if (uppy) return uppy;
  uppy = new Uppy({
    autoProceed: false,
    allowMultipleUploadBatches: true,
    restrictions: { allowedFileTypes: ACCEPTED_UPLOAD_EXTENSIONS.map((e) => `.${e}`) },
  });
  const q = (key: string) => `?key=${encodeURIComponent(key)}`;
  uppy.use(AwsS3, {
    // Always multipart: one code path for a 20 MB voice memo and a 20 GB screen recording.
    shouldUseMultipart: true,
    // 5 MB minimum part size (S3 rule), growing so even a 40 GB file stays under 10,000 parts.
    getChunkSize: (file: { size: number }) => Math.max(5 * 1024 * 1024, Math.ceil((file.size ?? 0) / 9000)),
    async createMultipartUpload(file) {
      const out = await api<{ uploadId: string; key: string }>("/uploads/multipart", {
        method: "POST",
        json: { filename: file.name, type: file.type || null, size: file.size ?? 0 },
      });
      const itemId = itemIdOf(file);
      if (itemId) keyByItem.set(itemId, out.key);
      return out;
    },
    async signPart(_file, { uploadId, key, partNumber }) {
      return api<{ url: string; headers: Record<string, string>; expires: number }>(`/uploads/multipart/${encodeURIComponent(String(uploadId))}/${partNumber}${q(key)}`);
    },
    async listParts(_file, { uploadId, key }) {
      return api<Array<{ PartNumber: number; Size: number; ETag: string }>>(`/uploads/multipart/${encodeURIComponent(String(uploadId))}${q(key)}`);
    },
    async completeMultipartUpload(_file, { uploadId, key, parts }) {
      return api<{ location: string }>(`/uploads/multipart/${encodeURIComponent(String(uploadId))}/complete${q(key)}`, {
        method: "POST",
        json: { parts },
      });
    },
    async abortMultipartUpload(_file, { uploadId, key }) {
      await api(`/uploads/multipart/${encodeURIComponent(String(uploadId))}${q(key)}`, { method: "DELETE" });
    },
  });

  uppy.on("upload-progress", (file, progress) => {
    const itemId = itemIdOf(file);
    if (!itemId || !progress.bytesTotal) return;
    updateItem(itemId, { status: "uploading", progress: progress.bytesUploaded / progress.bytesTotal });
  });
  uppy.on("upload-success", (file) => {
    const itemId = itemIdOf(file);
    if (!itemId) return;
    void finish(itemId);
  });
  uppy.on("upload-error", (file, error) => {
    const itemId = itemIdOf(file);
    if (!itemId) return;
    updateItem(itemId, { status: "error", error: error?.message ?? "Upload failed" });
  });
  return uppy;
}

async function finish(itemId: string) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || !item.sha256) return;
  updateItem(itemId, { status: "finishing", progress: 1 });
  const key = keyByItem.get(itemId);
  if (!key) {
    updateItem(itemId, { status: "error", error: "Storage did not return a key" });
    return;
  }
  const body: UploadFinishInput = {
    key,
    sha256: item.sha256,
    bytes: item.size,
    mimeType: item.type || null,
    originalFilename: item.name,
    title: item.title.trim() || titleFromFilename(item.name),
    recordedAt: new Date(item.recordedAt).toISOString(),
    workspaceId: item.workspaceId,
    source: item.source,
    partyIds: item.people.map((p) => p.id),
  };
  try {
    const out = await api<{ interactionId: number; mediaId: number }>("/uploads/finish", { method: "POST", json: body });
    updateItem(itemId, { status: "done", interactionId: out.interactionId });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  } catch (err) {
    if (err instanceof ApiError && err.code === "duplicate") {
      const dup = err.body.duplicate as { interactionId: number | null; title: string | null } | undefined;
      updateItem(itemId, { status: "duplicate", duplicate: dup ?? { interactionId: null, title: null } });
      return;
    }
    updateItem(itemId, { status: "error", error: err instanceof Error ? err.message : "Could not record the upload" });
  }
}

async function hashAndCheck(item: UploadItem) {
  try {
    const sha = await sha256File(item.file, (p) => updateItem(item.id, { progress: p }));
    updateItem(item.id, { sha256: sha, progress: 0 });
    const { duplicate } = await api<{ duplicate: { interactionId: number | null; title: string | null } | null }>("/uploads/check", {
      method: "POST",
      json: { sha256: sha },
    });
    updateItem(item.id, duplicate ? { status: "duplicate", duplicate } : { status: "ready" });
  } catch (err) {
    updateItem(item.id, { status: "error", error: err instanceof Error ? err.message : "Could not read the file" });
  }
}

export const uploadStore = {
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  getState: () => state,
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
  addFiles(files: FileList | File[], defaults: Partial<Pick<UploadItem, "workspaceId" | "source">> = {}) {
    const list = Array.from(files).filter(isAcceptedFile);
    const items: UploadItem[] = list.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      title: titleFromFilename(file.name),
      recordedAt: toLocalDateInput(new Date(file.lastModified || Date.now())),
      workspaceId: defaults.workspaceId ?? null,
      people: [],
      source: defaults.source ?? "upload",
      status: "hashing",
      progress: 0,
      sha256: null,
      duplicate: null,
      interactionId: null,
      error: null,
    }));
    if (!items.length) return { added: 0, rejected: Array.from(files).length };
    set((s) => ({ items: [...s.items, ...items], dialogOpen: true }));
    items.forEach((it) => void hashAndCheck(it));
    return { added: items.length, rejected: Array.from(files).length - items.length };
  },
  update: updateItem,
  remove(id: string) {
    const it = state.items.find((i) => i.id === id);
    if (it?.uppyId) {
      try {
        getUppy().removeFile(it.uppyId);
      } catch {
        /* already gone */
      }
    }
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
  clearFinished() {
    set((s) => ({ items: s.items.filter((i) => !["done", "duplicate", "error"].includes(i.status)) }));
  },
  retry(id: string) {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    updateItem(id, { status: "hashing", error: null, progress: 0, uppyId: undefined });
    void hashAndCheck({ ...it, status: "hashing", error: null });
  },
  /** Starts every item that is ready. */
  start() {
    const u = getUppy();
    const ready = state.items.filter((i) => i.status === "ready");
    for (const it of ready) {
      try {
        const uppyId = u.addFile({ name: it.name, type: it.type || undefined, data: it.file, source: "Local", meta: { itemId: it.id } });
        updateItem(it.id, { status: "uploading", progress: 0, uppyId });
      } catch (err) {
        updateItem(it.id, { status: "error", error: err instanceof Error ? err.message : "Could not queue file" });
      }
    }
    if (ready.length) void u.upload();
  },
};

export function useUploads(): State {
  return useSyncExternalStore(uploadStore.subscribe, uploadStore.getState, uploadStore.getState);
}

export function uploadsInProgress(items: UploadItem[]): number {
  return items.filter((i) => i.status === "uploading" || i.status === "finishing" || i.status === "hashing").length;
}
