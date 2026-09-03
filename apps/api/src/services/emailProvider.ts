import type { Queryable } from '../db/pool';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export interface EmailProvider {
  readonly kind: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * No-op provider for environments where outgoing e-mail is not configured yet.
 * Never logs message content so tokens cannot leak into logs.
 */
export class NoopEmailProvider implements EmailProvider {
  readonly kind = 'noop';

  async send(_message: EmailMessage): Promise<void> {
    // Intentionally does nothing until an SMTP driver is configured.
    return Promise.resolve();
  }
}

/**
 * Development/test provider. Stores messages in the dev_email_outbox table so
 * integration tests and local development can read verification links.
 * It must never be enabled in production (guarded by configuration).
 */
export class DevelopmentEmailProvider implements EmailProvider {
  readonly kind = 'dev';

  constructor(
    private readonly db: Queryable,
    private readonly enabled: boolean,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    if (!this.enabled) {
      throw new Error('DevelopmentEmailProvider is disabled');
    }
    await this.db.query(
      `INSERT INTO dev_email_outbox
         (recipient_email, subject, body, attachment_name, attachment_content_type, attachment_base64)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        message.to,
        message.subject,
        message.text,
        message.attachments?.[0]?.filename ?? null,
        message.attachments?.[0]?.contentType ?? null,
        message.attachments?.[0] ? message.attachments[0].content.toString('base64') : null,
      ],
    );
  }
}

/**
 * Deterministic provider used by tests and local QA. It records every message
 * (recipient/subject/body/attachments) in process memory and can simulate a
 * provider failure on the next send.
 */
export class MockEmailProvider implements EmailProvider {
  readonly kind = 'mock';
  private failNextSend = false;
  readonly sent: EmailMessage[] = [];

  failNext(): void {
    this.failNextSend = true;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('Mock email provider failure');
    }
    this.sent.push({
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content),
      })),
    });
  }
}

export function createEmailProvider(
  driver: 'dev' | 'noop',
  devOutboxEnabled: boolean,
  db: Queryable,
): EmailProvider {
  if (driver === 'dev') {
    return new DevelopmentEmailProvider(db, devOutboxEnabled);
  }
  return new NoopEmailProvider();
}
