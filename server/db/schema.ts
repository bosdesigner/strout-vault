// Hand-written Drizzle schema matching db/migrations/0001 and 0002 exactly.
// This file describes the production tables; it never generates migrations.
// Schema changes go only in a new db/migrations/000N_<name>.sql file.
import {
  pgTable,
  text,
  bigserial,
  bigint,
  boolean,
  integer,
  real,
  numeric,
  date,
  timestamp,
  jsonb,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const id = () => bigserial("id", { mode: "number" }).primaryKey();
const ref = (name: string) => bigint(name, { mode: "number" });

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  owner: text("owner").notNull().default("Ben Strout"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const parties = pgTable("parties", {
  id: id(),
  kind: text("kind").notNull(), // person | org
  name: text("name").notNull(),
  emails: text("emails").array().default([]),
  phones: text("phones").array().default([]),
  location: text("location"),
  website: text("website"),
  externalRefs: jsonb("external_refs").default({}),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const roles = pgTable("roles", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  partyId: ref("party_id").notNull().references(() => parties.id),
  role: text("role").notNull(),
  status: text("status").notNull().default("active"),
  market: text("market"),
  detail: text("detail"),
  startedAt: date("started_at"),
  endedAt: date("ended_at"),
  sourceInteractionId: ref("source_interaction_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const affiliations = pgTable("affiliations", {
  id: id(),
  personId: ref("person_id").notNull().references(() => parties.id),
  orgId: ref("org_id").notNull().references(() => parties.id),
  title: text("title"),
  isCurrent: boolean("is_current").default(true),
});

export const projects = pgTable("projects", {
  id: id(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  address: text("address"),
  status: text("status"),
  externalRefs: jsonb("external_refs").default({}),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const projectParties = pgTable(
  "project_parties",
  {
    projectId: ref("project_id").references(() => projects.id),
    partyId: ref("party_id").references(() => parties.id),
    role: text("role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.partyId, t.role] })],
);

export const interactions = pgTable("interactions", {
  id: id(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  mediaId: ref("media_id"),
  kind: text("kind").notNull(), // call | meeting | email | text | in_person | other
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  title: text("title"),
  summary: text("summary"),
  transcript: text("transcript"),
  transcriptSegments: jsonb("transcript_segments"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  // 0002_recordings
  vaultId: text("vault_id").unique(),
  source: text("source"), // zoom | meet | upload | iphone_call | contractor_call
  sourceRef: text("source_ref"),
  legacyMeetingId: bigint("legacy_meeting_id", { mode: "number" }),
  originalFilename: text("original_filename"),
  contentSha256: text("content_sha256"),
  tags: text("tags").array().notNull().default([]),
  durationSec: real("duration_sec"),
  hostEmail: text("host_email"),
  participantsRaw: jsonb("participants_raw"),
  sourcePayload: jsonb("source_payload"),
  pipelineStatus: text("pipeline_status"), // queued | proxying | transcribing | indexing | ready | failed | null(=ready)
  pipelineError: text("pipeline_error"),
  pipelineUpdatedAt: timestamp("pipeline_updated_at", { withTimezone: true }),
  scoutedAt: timestamp("scouted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const media = pgTable("media", {
  id: id(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  source: text("source").notNull(),
  storage: text("storage").notNull().default("r2"), // b2 | r2 | local | zoom | s3_deep_archive
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type"),
  bytes: bigint("bytes", { mode: "number" }),
  durationSec: integer("duration_sec"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }),
  uploadedBy: ref("uploaded_by").references(() => parties.id),
  consentNotice: boolean("consent_notice"),
  originalFilename: text("original_filename"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  // 0002_recordings
  interactionId: ref("interaction_id").references(() => interactions.id),
  kind: text("kind"), // video | audio | transcript_vtt | chat | cc | other
  role: text("role"), // original | master | proxy | clip
  bucket: text("bucket"),
  storageClass: text("storage_class"),
  sha256: text("sha256"),
  bytesExpected: bigint("bytes_expected", { mode: "number" }),
  status: text("status"), // pending | verified | verified_stable | failed | missing | deleted_local
  derivedFrom: ref("derived_from"),
  sourceFileId: text("source_file_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  legacyFileId: bigint("legacy_file_id", { mode: "number" }),
  legacyArchiveId: bigint("legacy_archive_id", { mode: "number" }),
});

export const jobs = pgTable("jobs", {
  id: id(),
  mediaId: ref("media_id").notNull().references(() => media.id),
  stage: text("stage").notNull(), // transcribe | extract | index | clip
  status: text("status").notNull().default("pending"), // pending | running | done | failed | skipped
  attempts: integer("attempts").default(0),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const interactionParticipants = pgTable(
  "interaction_participants",
  {
    interactionId: ref("interaction_id").references(() => interactions.id),
    partyId: ref("party_id").references(() => parties.id),
    speakerLabel: text("speaker_label"),
    confidence: real("confidence"),
  },
  (t) => [primaryKey({ columns: [t.interactionId, t.partyId] })],
);

export const interactionLinks = pgTable(
  "interaction_links",
  {
    interactionId: ref("interaction_id").references(() => interactions.id),
    projectId: ref("project_id").references(() => projects.id),
  },
  (t) => [primaryKey({ columns: [t.interactionId, t.projectId] })],
);

export const facts = pgTable("facts", {
  id: id(),
  interactionId: ref("interaction_id").references(() => interactions.id),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  kind: text("kind").notNull(), // commitment | decision | price | followup | issue | preference | other
  text: text("text").notNull(),
  ownerPartyId: ref("owner_party_id").references(() => parties.id),
  aboutPartyId: ref("about_party_id").references(() => parties.id),
  projectId: ref("project_id").references(() => projects.id),
  amount: numeric("amount"),
  dueDate: date("due_date"),
  status: text("status").default("open"),
  confidence: real("confidence"),
  quoteStartSec: integer("quote_start_sec"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const relationships = pgTable("relationships", {
  id: id(),
  fromPartyId: ref("from_party_id").notNull().references(() => parties.id),
  toPartyId: ref("to_party_id").notNull().references(() => parties.id),
  kind: text("kind").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  evidenceCount: integer("evidence_count").default(0),
  notes: text("notes"),
});

export const reviewQueue = pgTable("review_queue", {
  id: id(),
  itemType: text("item_type").notNull(),
  proposal: jsonb("proposal").notNull(),
  reason: text("reason"),
  interactionId: ref("interaction_id").references(() => interactions.id),
  status: text("status").default("open"), // open | approved | rejected
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const schemaLog = pgTable("schema_log", {
  id: id(),
  change: text("change").notNull(),
  rationale: text("rationale"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const transcripts = pgTable("transcripts", {
  interactionId: ref("interaction_id").primaryKey().references(() => interactions.id),
  source: text("source").notNull(), // zoom_vtt | whisper | groq | imported
  model: text("model"),
  language: text("language"),
  segmentCount: integer("segment_count"),
  wordCount: integer("word_count"),
  hasWords: boolean("has_words").notNull().default(false),
  durationSec: real("duration_sec"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const segments = pgTable("segments", {
  id: id(),
  interactionId: ref("interaction_id").notNull().references(() => interactions.id),
  idx: integer("idx").notNull(),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
  speaker: text("speaker"),
  speakerPartyId: ref("speaker_party_id").references(() => parties.id),
  text: text("text").notNull(),
  words: jsonb("words"),
  // generated always as (to_tsvector('english', text)) stored. Never written by the app.
  tsv: tsvector("tsv"),
});

export const clipCandidates = pgTable("clip_candidates", {
  id: id(),
  interactionId: ref("interaction_id").notNull().references(() => interactions.id),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
  score: integer("score").notNull(),
  hook: text("hook"),
  why: text("why"),
  platforms: text("platforms"),
  status: text("status").notNull().default("new"), // new | approved | rejected | cut
  model: text("model"),
  clipMediaId: ref("clip_media_id"),
  clipPath: text("clip_path"),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  legacyId: bigint("legacy_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const clips = pgTable("clips", {
  id: id(),
  interactionId: ref("interaction_id").references(() => interactions.id),
  mediaId: ref("media_id"),
  path: text("path"),
  startSec: real("start_sec").notNull(),
  endSec: real("end_sec").notNull(),
  vertical: boolean("vertical").notNull().default(false),
  captions: boolean("captions").notNull().default(false),
  sourceRole: text("source_role"),
  bytes: bigint("bytes", { mode: "number" }),
  legacyId: bigint("legacy_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type Interaction = typeof interactions.$inferSelect;
export type Media = typeof media.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type ClipCandidate = typeof clipCandidates.$inferSelect;
export type Fact = typeof facts.$inferSelect;
