/// <reference lib="webworker" />
// Streams a File through hash-wasm's SHA-256 in 8 MB slices so multi-GB files
// never sit in memory at once. Posts progress, then the hex digest.
import { createSHA256 } from "hash-wasm";

interface Req {
  id: string;
  file: File;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, file } = e.data;
  try {
    const hasher = await createSHA256();
    const CHUNK = 8 * 1024 * 1024;
    let lastPost = 0;
    for (let off = 0; off < file.size; off += CHUNK) {
      const buf = await file.slice(off, Math.min(off + CHUNK, file.size)).arrayBuffer();
      hasher.update(new Uint8Array(buf));
      const now = Date.now();
      if (now - lastPost > 120) {
        lastPost = now;
        self.postMessage({ id, progress: Math.min(0.99, (off + buf.byteLength) / Math.max(1, file.size)) });
      }
    }
    self.postMessage({ id, sha256: hasher.digest("hex") });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
