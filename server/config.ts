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
