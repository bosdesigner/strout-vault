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
  // One run stops starting new work after this many seconds so hourly runs never overlap.
  WORKER_TIME_BUDGET_SEC: z.coerce.number().int().positive().default(50 * 60),
  // Bytes one run may download from Zoom before it stops and leaves the rest for the next run.
  WORKER_MAX_BYTES_PER_RUN: z.coerce.number().positive().default(20 * 1024 * 1024 * 1024),
  WORKER_TMP_DIR: z.string().optional(),
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
