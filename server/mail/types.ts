export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}
