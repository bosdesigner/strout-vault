// Which stored copy to play. Rules, in order (first that exists wins):
//   1. storage='r2' with role='proxy'
//   2. storage='r2' with kind video or audio
//   3. storage='b2' with role='original'
//   4. development only: storage='local' through the local driver
// In production storage='local' is a file on the Mac and 'zoom' is still at
// Zoom; neither is playable from the web, so they are never chosen unless the
// running driver says it can serve them (only the local driver does).

export interface PlayableCandidate {
  id: number;
  storage: string;
  bucket: string | null;
  storageKey: string;
  role: string | null;
  kind: string | null;
  status: string | null;
  mimeType: string | null;
}

const UNPLAYABLE_STATUS = new Set(["failed", "missing", "deleted_local", "pending"]);
const AV_KINDS = new Set(["video", "audio"]);

function isAv(m: PlayableCandidate): boolean {
  // Legacy rows may have kind=null for the recording itself; treat null as audio/video.
  return m.kind == null || AV_KINDS.has(m.kind);
}

function usable(m: PlayableCandidate): boolean {
  return !UNPLAYABLE_STATUS.has(m.status ?? "") && isAv(m);
}

/** Video before audio inside a tier, then lowest id for stability. */
function byPreference(a: PlayableCandidate, b: PlayableCandidate): number {
  const ka = a.kind === "video" ? 0 : a.kind === "audio" ? 1 : 2;
  const kb = b.kind === "video" ? 0 : b.kind === "audio" ? 1 : 2;
  return ka - kb || a.id - b.id;
}

export function pickVideoSource(
  files: PlayableCandidate[],
  canServe: (storage: string, key: string) => boolean,
): PlayableCandidate | null {
  const ok = files.filter((m) => usable(m) && canServe(m.storage, m.storageKey));
  const tiers: Array<(m: PlayableCandidate) => boolean> = [
    (m) => m.storage === "r2" && m.role === "proxy",
    (m) => m.storage === "r2",
    (m) => m.storage === "b2" && m.role === "original",
    (m) => m.storage === "local",
  ];
  for (const tier of tiers) {
    const matches = ok.filter(tier).sort(byPreference);
    if (matches.length) return matches[0];
  }
  return null;
}

/** media.storage values the running driver can play, for "has video" filters. */
export function servableStorages(canServe: (storage: string, key: string) => boolean): string[] {
  return ["r2", "b2", "local"].filter((s) => canServe(s, "probe/key"));
}
