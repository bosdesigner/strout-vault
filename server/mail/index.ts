import type { Config } from "../config.ts";
import { MemoryMailer } from "./memory.ts";
import { ResendMailer } from "./resend.ts";
import type { Mailer } from "./types.ts";

export type { Mailer, MailMessage } from "./types.ts";
export { MemoryMailer } from "./memory.ts";
export { ResendMailer } from "./resend.ts";

export function createMailer(config: Config): Mailer {
  if (config.RESEND_API_KEY) return new ResendMailer(config.RESEND_API_KEY, config.MAIL_FROM);
  if (config.isProd) {
    console.warn("[mail] RESEND_API_KEY is not set: contractor sign-in links will only be logged, not emailed.");
  }
  return new MemoryMailer(!config.isTest);
}
