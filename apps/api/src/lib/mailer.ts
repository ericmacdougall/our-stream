// SPDX-License-Identifier: AGPL-3.0-only
// SMTP adapter (ADR-0011: fakes for every adapter). The fake records messages for tests; the nodemailer
// implementation is used when SMTP_URL is configured; without SMTP the API logs that a message was
// skipped (without its link) so password sign-in keeps working on a bare install.
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  /** Most recent message to an address, if any. */
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

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

export function magicLinkMail(
  to: string,
  link: string,
  purpose: 'login' | 'invite',
  orgName?: string,
) {
  if (purpose === 'invite') {
    return {
      to,
      subject: `You have been invited to ${orgName ?? 'our-stream'}`,
      text: `You have been invited to join ${orgName ?? 'an organisation'} on our-stream.\n\nOpen this link to accept:\n${link}\n\nThe link can be used once and expires.`,
    };
  }
  return {
    to,
    subject: 'Your our-stream sign-in link',
    text: `Open this link to sign in:\n${link}\n\nThe link can be used once and expires shortly. If you did not request it, ignore this message.`,
  };
}
