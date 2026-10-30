import { z } from "zod";
import dotenv from "dotenv";

// .env is for local development only. On Replit the Secrets tab provides these
// as real environment variables and no .env file exists.
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().default(""),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().min(20, "ADMIN_PASSWORD_HASH must be a bcrypt hash (npm run hash-password)"),
  STORAGE_DRIVER: z.enum(["s3", "local"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./.data/storage"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_REGION: z.string().optional(),
  // Login attempts allowed per IP per LOGIN_RATE_WINDOW_MS. Tests lower this.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  // Session lifetime in seconds (default 30 days).
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(30 * 24 * 3600),
  // Contractor logins: magic links by email (Resend). Without RESEND_API_KEY links are logged, not sent.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("Strout Vault <vault@example.com>"),
  MAGIC_LINK_TTL_MIN: z.coerce.number().int().positive().default(20),
  // Tracked phone numbers (Twilio). Webhooks are refused until both are set.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // Test-only hook: exposes the last sent email at /api/_test/last-mail (never in production).
  EXPOSE_TEST_MAIL: z.enum(["0", "1"]).default("0"),

  // ---- The worker (Phase 4): `npm run worker`, an hourly Scheduled Deployment on Replit. ----
  // Zoom Server-to-Server OAuth app with read-only scopes. Without these the Zoom step is skipped.
  ZOOM_ACCOUNT_ID: z.string().optional(),
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),
  ZOOM_API_BASE: z.string().default("https://api.zoom.us/v2"),
  ZOOM_OAUTH_BASE: z.string().default("https://zoom.us"),
  // First month to sweep when there is no cursor yet (YYYY-MM). Default: ZOOM_SYNC_OVERLAP_MONTHS back from today.
  ZOOM_SYNC_FROM: z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM").optional(),
  // Months re-checked behind the cursor every run: Zoom finishes processing recordings hours or days late.
  ZOOM_SYNC_OVERLAP_MONTHS: z.coerce.number().int().min(0).max(24).default(3),
  // Where originals the worker fetches are archived. Default: b2 when configured, else the upload target.
  ARCHIVE_STORAGE: z.enum(["b2", "r2", "local"]).optional(),
  // Groq speech-to-text for recordings without a Zoom transcript. Costs money: nothing is sent unless
  // GROQ_API_KEY is set AND the month's spend stays under GROQ_MONTHLY_BUDGET_USD (default 0 = off).
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("whisper-large-v3-turbo"),
  GROQ_URL: z.string().optional(),
  GROQ_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(0),
  GROQ_MAX_UPLOAD_MB: z.coerce.number().positive().default(24),
  GROQ_CHUNK_SECONDS: z.coerce.number().int().positive().default(900),
  GROQ_AUDIO_KBPS: z.coerce.number().int().positive().default(24),
  // zoom: use Zoom's own VTT (transcript, then captions) when present, Groq otherwise. groq: always Groq.
  TRANSCRIBE_PREFER: z.enum(["zoom", "groq"]).default("zoom"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),
  // ---- Clips (Phase 5) ----
  // Claude reads new transcripts for clip-worthy moments. Costs money: nothing is sent unless
  // ANTHROPIC_API_KEY is set AND the month's spend stays under SCOUT_MONTHLY_BUDGET_USD (default 0 = off).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_API_URL: z.string().optional(),
  SCOUT_MODEL: z.string().default("claude-opus-5-5"),
  SCOUT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  SCOUT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(0),
  // Which recording sources are worth scouting (phone calls with clients are not clip material).
  SCOUT_SOURCES: z.string().default("zoom,meet,upload"),
  SCOUT_MAX_PER_RUN: z.coerce.number().int().positive().default(20),
  // ---- Extraction (Jarvis step 2, docs/EXTRACTION.md) ----
  // Claude reads each filed recording once and queues commitments, decisions, prices, speaker
  // matches and project links in review_queue; nothing is written anywhere else until Ben approves.
  // Same key as the scout, its own budget (spend_ledger provider "anthropic-extract"); 0 = off.
  EXTRACT_MODEL: z.string().default("claude-opus-5-5"),
  EXTRACT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  EXTRACT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(0),
  // Workspaces whose recordings and threads are read. "*" is every workspace except phalanx
  // (investor material), personal and inbox; phalanx is only read when listed: "*,phalanx".
  EXTRACT_WORKSPACES: z.string().default("*"),
  EXTRACT_MAX_PER_RUN: z.coerce.number().int().positive().default(40),
  // Texts and email (Jarvis step 5 B, docs/FOLLOW-THROUGH.md): threads with a message in the last
  // N days are read, and read again when they gain messages (only the new ones are sent). 0 = off.
  EXTRACT_THREAD_DAYS: z.coerce.number().int().min(0).default(30),
  EXTRACT_THREADS_PER_RUN: z.coerce.number().int().positive().default(50),
  // Unfiled recordings the workspace classifier files at 0.85+ (a title rule such as "AnotherStory
  // Assessment", or a known person in the title) are read under that workspace, and the filing is
  // queued for review. Never phalanx unless EXTRACT_WORKSPACES lists it. "0" = unfiled never read.
  EXTRACT_UNFILED: z.enum(["0", "1"]).default("1"),
  // Phase 1 v2: facts at this confidence or more are written straight to `facts` (status open);
  // between EXTRACT_MIN_CONFIDENCE and this they go to Review as before.
  EXTRACT_FACT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  // The backfill reads the last N days first (newest first), then older items back to EXTRACT_MAX_AGE_DAYS.
  EXTRACT_RECENT_DAYS: z.coerce.number().int().min(1).default(30),
  EXTRACT_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(365),
  // "1": only interactions the content classifier has seen are read (so nothing is read under the wrong workspace).
  EXTRACT_REQUIRE_CLASSIFIED: z.enum(["0", "1"]).default("1"),
  // ---- Content routing (Phase 1 v2, docs/phase1-verification.md) ----
  // Worker step `classify` files every interaction from its content: the phalanx guard, the Gmail
  // account, participants, and Claude reading the first ~2,000 characters when those do not settle
  // it. Same key as the scout, its own budget (spend_ledger provider "anthropic-classify"); 0 = the
  // deterministic signals still file what they can and the rest waits.
  CLASSIFY_MODEL: z.string().default("claude-opus-5-5"),
  CLASSIFY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  CLASSIFY_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(0),
  CLASSIFY_MAX_PER_RUN: z.coerce.number().int().positive().default(400),
  CLASSIFY_BATCH: z.coerce.number().int().min(1).max(25).default(10),
  // Claude's read files an item at this confidence or more; below it the item stays in inbox.
  CLASSIFY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  // ---- People linking (Phase 1 v2): worker step `link` ----
  LINK_MAX_PER_RUN: z.coerce.number().int().positive().default(500),
  // ---- Follow-through (Jarvis step 5 C, docs/FOLLOW-THROUGH.md) ----
  // Notices commitments that were kept, overdue or stale, messages waiting on Ben's reply and
  // leads or clients gone quiet, and queues each on Review with a drafted reply. Nothing is sent.
  // Claude decides "was it kept?" and writes the drafts; its own budget (spend_ledger provider
  // "anthropic-followthrough"); 0 = off (the step only counts what it would look at).
  FOLLOWTHROUGH_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(0),
  FOLLOWTHROUGH_MODEL: z.string().default("claude-opus-5-5"),
  FOLLOWTHROUGH_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  // Claude calls per hourly run (a done-check or a draft each).
  FOLLOWTHROUGH_MAX_PER_RUN: z.coerce.number().int().positive().default(20),
  // An inbound message from a known person with no reply after this many weekday hours is "waiting on you".
  FOLLOWTHROUGH_REPLY_HOURS: z.coerce.number().min(1).default(24),
  // A commitment with no due date and no contact since is nudged after this many weekdays.
  FOLLOWTHROUGH_NUDGE_DAYS: z.coerce.number().int().min(1).default(5),
  // An open lead or active client whose last message is Ben's, unanswered for this many days, has "gone quiet".
  FOLLOWTHROUGH_QUIET_DAYS: z.coerce.number().int().min(1).default(7),
  // Only messages from the last N days count (older silence is not a follow-up anymore).
  FOLLOWTHROUGH_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(30),
  // Proposals below this confidence are dropped rather than queued.
  EXTRACT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  // ---- Leads (Jarvis step 3, docs/LEADS.md) ----
  // Read-only sources the worker mirrors into lead_records every run. Each is optional.
  //   LEADS_DATABASE_URL : AnotherStoryBLDR's Postgres (a SELECT-only role on leads + site_leads).
  //   AIRTABLE_TOKEN     : a personal access token with data.records:read on the Client Pipeline base.
  LEADS_DATABASE_URL: z.string().optional(),
  AIRTABLE_TOKEN: z.string().optional(),
  AIRTABLE_BASE_ID: z.string().default("appK6q2gwVCCc0gmF"),
  AIRTABLE_API_URL: z.string().default("https://api.airtable.com"),
  // Workspace a lead's party gets its prospect role in.
  LEADS_WORKSPACE: z.string().default("another_story"),
  // ---- Texts + email (Jarvis step 4, docs/MESSAGES.md) ----
  // Ben's own identifiers, comma-separated: his messages get speaker OWNER_NAME and are never
  // queued as unknown senders. Each connected Gmail account's address counts as his too.
  OWNER_PHONES: z.string().optional(),
  OWNER_EMAILS: z.string().optional(),
  OWNER_NAME: z.string().default("Ben"),
  // Directory holding message_routing.yml and message_blocklist.yml.
  MESSAGES_CONFIG_DIR: z.string().default("./config"),
  // 32 random bytes (hex or base64) that encrypt Gmail refresh tokens at rest (AES-256-GCM).
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  MESSAGES_ENCRYPTION_KEY: z.string().optional(),
  // Google OAuth client (Web application) for connecting Gmail accounts, scope gmail.readonly only.
  // Authorized redirect URI: <PUBLIC_URL>/api/messages/gmail/callback
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_AUTHORIZE_URL: z.string().default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_OAUTH_TOKEN_URL: z.string().default("https://oauth2.googleapis.com/token"),
  GMAIL_API_BASE: z.string().default("https://gmail.googleapis.com/gmail/v1"),
  // Google Meet (docs/INGEST.md): the same OAuth client, a separate grant per account with
  // drive.meet.readonly (+ calendar.events.readonly when connected with ?calendar=1).
  // Authorized redirect URI: <PUBLIC_URL>/api/messages/meet/callback
  DRIVE_API_BASE: z.string().default("https://www.googleapis.com/drive/v3"),
  CALENDAR_API_BASE: z.string().default("https://www.googleapis.com/calendar/v3"),
  // Include recordings that live in Workspace shared drives (corpora=allDrives). "0" for My Drive only.
  MEET_SHARED_DRIVES: z.enum(["0", "1"]).default("1"),
  // Days the first backfill reaches back (npm run messages:gmail -- --since overrides it).
  GMAIL_BACKFILL_DAYS: z.coerce.number().int().positive().default(365),
  // Worker steps to run when no --steps argument is given (the 10-minute messages deployment sets "gmail,embed").
  WORKER_STEPS: z.string().optional(),
  // Rendering approved candidates with ffmpeg: 9:16 crop ("vertical") or the whole frame ("full").
  CLIP_FORMAT: z.enum(["vertical", "full"]).default("vertical"),
  CLIP_PADDING_SEC: z.coerce.number().min(0).max(10).default(1),
  CLIP_CAPTIONS: z.enum(["0", "1"]).default("1"),
  CLIP_MAX_PER_RUN: z.coerce.number().int().positive().default(10),
  // Directory holding the caption font (DejaVu Sans Bold ships in server/worker/assets/fonts).
  CLIP_FONTS_DIR: z.string().optional(),
  // One run stops starting new work after this many seconds so hourly runs never overlap.
  WORKER_TIME_BUDGET_SEC: z.coerce.number().int().positive().default(50 * 60),
  // Bytes one run may download from Zoom before it stops and leaves the rest for the next run.
  WORKER_MAX_BYTES_PER_RUN: z.coerce.number().positive().default(20 * 1024 * 1024 * 1024),
  WORKER_TMP_DIR: z.string().optional(),

  // ---- Embeddings + the MCP server (docs/MCP.md) ----
  // Which provider fills chunks.embedding (vector(1024)) and embeds search queries.
  //   voyage : Voyage AI voyage-3.5 (1024 dims natively, document/query input types). Needs VOYAGE_API_KEY.
  //   openai : text-embedding-3-small/large with dimensions=1024. Needs OPENAI_API_KEY.
  //   fake   : deterministic hashing, no network. Development and tests only.
  //   off    : no chunking or embedding; search_conversations is keyword-only.
  EMBEDDING_PROVIDER: z.enum(["voyage", "openai", "fake", "off"]).default("off"),
  EMBEDDING_MODEL: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_API_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_URL: z.string().optional(),
  // Recordings embedded per worker run and parallel provider requests.
  EMBED_MAX_PER_RUN: z.coerce.number().int().positive().default(50),
  EMBED_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Restricted Postgres roles the MCP server connects as (db/migrations/0006_mcp.sql). Required in
  // production; development and tests fall back to DATABASE_URL with a warning when unset.
  MCP_READER_DATABASE_URL: z.string().optional(),
  MCP_PROPOSER_DATABASE_URL: z.string().optional(),
  MCP_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  OAUTH_ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(3600),
  OAUTH_REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(30 * 24 * 3600),
  OAUTH_CODE_TTL_SEC: z.coerce.number().int().positive().default(10 * 60),
});

export type Config = z.infer<typeof envSchema> & {
  isProd: boolean;
  isTest: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}\nSee .env.example for every variable.`);
  }
  const c = parsed.data;
  if (c.STORAGE_DRIVER === "s3") {
    const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter(
      (k) => !(c as Record<string, unknown>)[k],
    );
    if (missing.length) {
      throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(", ")} (see .env.example)`);
    }
  }
  return { ...c, isProd: c.NODE_ENV === "production", isTest: c.NODE_ENV === "test" };
}
