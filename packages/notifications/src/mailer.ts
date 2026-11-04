// SPDX-License-Identifier: AGPL-3.0-only
// Email channel adapter (ADR-0005 §4, ADR-0011: a fake for every adapter). Plain text only: digests
// carry titles the recipient may currently read and nothing else, so there is nothing to render as HTML.
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Records messages; `failNext(n)` makes the next n sends throw (digest retry tests). */
export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private failures = 0;
  failNext(n: number): void {
    this.failures = n;
  }
  async send(message: MailMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('fake mailer: simulated SMTP failure');
    }
    this.sent.push(message);
  }
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }
}

/** Without SMTP_URL the worker logs that a digest was skipped (recipient and count only, never content). */
export class LoggingMailer implements Mailer {
  constructor(private readonly log: { warn: (o: object, msg?: string) => void }) {}
  async send(message: MailMessage): Promise<void> {
    this.log.warn(
      { to: message.to, subject: message.subject },
      'SMTP_URL not configured; message not delivered',
    );
  }
}

export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
