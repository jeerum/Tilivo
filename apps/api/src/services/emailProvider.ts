import type { Queryable } from '../db/pool';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
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
      `INSERT INTO dev_email_outbox (recipient_email, subject, body)
       VALUES ($1, $2, $3)`,
      [message.to, message.subject, message.text],
    );
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
