// Types shared by the API and the client.

export type Source = "zoom" | "meet" | "upload" | "iphone_call" | "contractor_call" | "voice_memo" | "apple_note" | "imessage" | "gmail";
export type PipelineStatus = "queued" | "proxying" | "transcribing" | "indexing" | "ready" | "failed";
export type StorageKind = "b2" | "r2" | "local" | "zoom" | "s3_deep_archive";

export interface ParticipantRef {
  id: number;
  name: string;
}

export interface LibraryCard {
  id: number;
  title: string | null;
  occurredAt: string | null;
  durationSec: number | null;
  source: Source | string | null;
  workspaceId: string | null;
  pipelineStatus: PipelineStatus | null;
  /** First meaningful line of summary/transcript; shown when the title is generic. */
  preview: string | null;
  participants: ParticipantRef[];
  participantCount: number;
  hasVideo: boolean;
  tags: string[];
}

export interface LibraryPage {
  items: LibraryCard[];
  nextCursor: string | null;
}

export interface WorkspaceRef {
  id: string;
  name: string;
}

export interface RoleChip {
  workspaceId: string;
  workspaceName: string;
  role: string;
  status: string;
  market: string | null;
  detail: string | null;
}

export interface RecordingParticipant {
  id: number;
  name: string;
  kind: "person" | "org" | string;
  speakerLabel: string | null;
  confidence: number | null;
  roles: RoleChip[];
}

export interface TranscriptLine {
  id: number;
  idx: number;
  startSec: number;
  endSec: number;
  speaker: string | null;
  speakerPartyId: number | null;
  text: string;
}

export interface MediaFile {
  id: number;
  storage: StorageKind | string;
  bucket: string | null;
  storageKey: string;
  role: string | null;
  kind: string | null;
  bytes: number | null;
  mimeType: string | null;
  status: string | null;
  originalFilename: string | null;
  sha256: string | null;
  playable: boolean;
}

export interface FactItem {
  id: number;
  kind: string;
  text: string;
  status: string | null;
  quoteStartSec: number | null;
  /** The words it came from, verbatim (facts written by the extractor). */
  quote?: string | null;
  ownerParty: ParticipantRef | null;
  aboutParty: ParticipantRef | null;
  amount: number | null;
  dueDate: string | null;
}

export interface ClipCandidateItem {
  id: number;
  startSec: number;
  endSec: number;
  score: number;
  hook: string | null;
  why: string | null;
  status: "new" | "approved" | "rejected" | "cut" | string;
  /** Set once the worker rendered the clip into the bucket (downloadable). */
  clipMediaId?: number | null;
}

export interface JobItem {
  id: number;
  mediaId: number;
  stage: string;
  status: string;
  attempts: number | null;
  error: string | null;
  updatedAt: string | null;
}

export interface RecordingDetail {
  id: number;
  title: string | null;
  occurredAt: string | null;
  durationSec: number | null;
  source: string | null;
  kind: string;
  workspace: WorkspaceRef | null;
  tags: string[];
  summary: string | null;
  pipelineStatus: PipelineStatus | null;
  pipelineError: string | null;
  vaultId: string | null;
  originalFilename: string | null;
  updatedAt: string | null;
  participants: RecordingParticipant[];
  video: { url: string; mediaId: number; mimeType: string | null; kind: string | null; expiresAt: string | null } | null;
  files: MediaFile[];
  jobs: JobItem[];
  transcript: { source: string; model: string | null; language: string | null; segmentCount: number | null; wordCount: number | null } | null;
  segmentCount: number;
  hasTranscriptText: boolean;
  facts: FactItem[];
  clips: ClipCandidateItem[];
  projects: ProjectRef[];
  /** Speaker labels in the transcript and which person (if any) each is assigned to. */
  speakers: Array<{ label: string; partyId: number | null; lines: number }>;
}

export interface ProjectRef {
  id: number;
  name: string;
  status: string | null;
  workspaceId: string;
  workspaceName: string;
}

export interface PersonListItem {
  id: number;
  kind: "person" | "org" | string;
  name: string;
  location: string | null;
  emails: string[];
  roles: RoleChip[];
  detail: string | null;
  interactionCount: number;
  lastSeenAt: string | null;
  orgs: Array<{ id: number; name: string }>;
}

export interface PersonRole extends RoleChip {
  id: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface PersonDetail {
  id: number;
  kind: "person" | "org" | string;
  name: string;
  emails: string[];
  phones: string[];
  location: string | null;
  website: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  roles: PersonRole[];
  affiliations: Array<{ id: number; title: string | null; isCurrent: boolean | null; other: { id: number; name: string; kind: string } }>;
  interactions: Array<{ id: number; title: string | null; occurredAt: string | null; durationSec: number | null; source: string | null; pipelineStatus: string | null; workspaceId: string | null; speakerLabel: string | null }>;
  facts: Array<FactItem & { interaction: { id: number; title: string | null; occurredAt: string | null } | null }>;
  projects: Array<ProjectRef & { role: string }>;
}

export interface ProjectListItem {
  id: number;
  workspaceId: string;
  workspaceName: string;
  name: string;
  address: string | null;
  status: string | null;
  partyCount: number;
  interactionCount: number;
  openFacts: number;
  lastActivityAt: string | null;
  parties: Array<{ id: number; name: string; role: string }>;
}

export interface ProjectDetail {
  id: number;
  workspaceId: string;
  workspaceName: string;
  name: string;
  address: string | null;
  status: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  parties: Array<{ id: number; kind: string; name: string; projectRole: string; roles: RoleChip[] }>;
  interactions: Array<{ id: number; title: string | null; occurredAt: string | null; durationSec: number | null; source: string | null; pipelineStatus: string | null }>;
  facts: Array<FactItem & { interaction: { id: number; title: string | null } | null }>;
}

export interface ReviewItem {
  id: number;
  itemType: string;
  proposal: Record<string, unknown>;
  reason: string | null;
  status: "open" | "approved" | "rejected" | string;
  createdAt: string | null;
  decidedAt: string | null;
  interaction: { id: number; title: string | null; occurredAt: string | null; workspaceId: string | null } | null;
  party: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
  speakerLabel: string | null;
  startSec: number | null;
  confidence: number | null;
}

export interface SearchLinePart {
  t: string;
  /** true when this part matched the query (render highlighted). */
  m: boolean;
}

export interface SearchLine {
  segmentId: number;
  startSec: number;
  speaker: string | null;
  parts: SearchLinePart[];
}

export interface SearchGroup {
  interactionId: number;
  title: string | null;
  occurredAt: string | null;
  source: string | null;
  workspaceId: string | null;
  hitCount: number;
  lines: SearchLine[];
}

export interface SearchResponse {
  query: string;
  page: number;
  pageSize: number;
  groups: SearchGroup[];
  hasMore: boolean;
  tookMs: number;
}

export interface PartySuggestion {
  id: number;
  name: string;
  kind: string;
  detail: string | null;
}

export interface UploadFinishInput {
  key: string;
  sha256: string;
  bytes: number;
  mimeType: string | null;
  originalFilename: string;
  title: string;
  recordedAt: string;
  workspaceId: string | null;
  source: "upload" | "iphone_call" | "contractor_call" | "voice_memo";
  partyIds: number[];
  /** Device ingest (Mac collector, iPhone Shortcut): upserted by (source, sourceRef). */
  sourceRef?: string | null;
  durationSec?: number | null;
  participantsRaw?: unknown[] | null;
  sourcePayload?: Record<string, unknown> | null;
}

export const ACCEPTED_UPLOAD_EXTENSIONS = ["mp4", "mov", "m4a", "mp3", "wav", "webm", "mkv"] as const;
