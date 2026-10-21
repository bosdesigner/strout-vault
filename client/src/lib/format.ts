import { format, formatDistanceToNowStrict, isThisYear, parseISO } from "date-fns";
export { formatDuration, formatTimestamp, formatBytes, isGenericTitle, titleFromFilename } from "@shared/text";

export function formatDate(iso: string | null | undefined, opts: { withTime?: boolean } = {}): string {
  if (!iso) return "";
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (opts.withTime) return format(d, isThisYear(d) ? "EEE, MMM d · h:mm a" : "MMM d, yyyy · h:mm a");
  return format(d, isThisYear(d) ? "MMM d" : "MMM d, yyyy");
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export const SOURCE_LABEL: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  upload: "Upload",
  iphone_call: "Phone call",
  contractor_call: "Contractor call",
};

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  proxying: "Preparing video",
  transcribing: "Transcribing",
  indexing: "Indexing",
  ready: "Ready",
  failed: "Failed",
};

export function statusLabel(s: string | null | undefined): string {
  if (!s) return "Ready";
  return STATUS_LABEL[s] ?? s;
}

export function isReady(s: string | null | undefined): boolean {
  return !s || s === "ready";
}

export const ROLE_LABEL: Record<string, string> = {
  client: "client",
  contractor: "contractor",
  vendor: "vendor",
  partner: "partner",
  investor: "investor",
  team: "team",
  prospect: "prospect",
  advisor: "advisor",
  other: "other",
};

export function toLocalDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
