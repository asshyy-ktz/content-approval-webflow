import { db } from "../db";

export interface MailMessage {
  siteId: string;
  to: string;
  subject: string;
  body: string;
  kind: string;
}

/** Mail transport interface. The default implementation only logs; swap in SES/SMTP/etc. with setMailer(). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

class LoggingMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    db.run(`INSERT INTO mail_log (site_id, to_email, subject, body, kind) VALUES (?, ?, ?, ?, ?)`, [message.siteId, message.to, message.subject, message.body, message.kind]);
    // eslint-disable-next-line no-console
    console.log(`[mailer:stub] to=${message.to} kind=${message.kind} subject=${JSON.stringify(message.subject)}`);
  }
}

export let mailer: Mailer = new LoggingMailer();

export function setMailer(next: Mailer): void {
  mailer = next;
}

/** Fire-and-forget notification: mail failures never break the action that triggered them. */
export function notify(message: MailMessage): void {
  mailer.send(message).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[mailer] failed to send ${message.kind} to ${message.to}:`, err);
  });
}

export function notifyMany(siteId: string, recipients: Iterable<string>, kind: string, subject: string, body: string, exclude?: string): void {
  for (const to of new Set(recipients)) {
    if (to && to !== exclude && !to.endsWith(".invalid")) notify({ siteId, to, subject, body, kind });
  }
}
