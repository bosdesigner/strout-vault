let worker: Worker | null = null;
const pending = new Map<string, { resolve: (hex: string) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/sha256.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: string; progress?: number; sha256?: string; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress !== undefined) p.onProgress?.(e.data.progress);
    if (e.data.sha256) {
      pending.delete(e.data.id);
      p.resolve(e.data.sha256);
    }
    if (e.data.error) {
      pending.delete(e.data.id);
      p.reject(new Error(e.data.error));
    }
  };
  worker.onerror = (ev) => {
    for (const [id, p] of pending) {
      p.reject(new Error(ev.message || "hash worker failed"));
      pending.delete(id);
    }
    worker = null;
  };
  return worker;
}

/** SHA-256 of a File, computed off the main thread. */
export function sha256File(file: File, onProgress?: (p: number) => void): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, file });
  });
}
