import type { Mailer, MailMessage } from "./types.ts";

/** Keeps sent mail in memory (tests) and, when `log` is set, prints the link to the console (development). */
export class MemoryMailer implements Mailer {
  readonly name = "memory";
  readonly sent: MailMessage[] = [];
  constructor(private readonly log = false) {}

  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sent.length > 50) this.sent.shift();
    if (this.log) {
      console.log(`\n[mail] to ${msg.to}: ${msg.subject}\n${msg.text}\n`);
    }
  }

  last(): MailMessage | null {
    return this.sent[this.sent.length - 1] ?? null;
  }
}
