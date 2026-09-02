import type { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { Db, DbClient, Queryable } from '../db/pool';

export type AuditAction =
  | 'AUTH.REGISTERED'
  | 'AUTH.EMAIL_VERIFICATION_REQUESTED'
  | 'AUTH.EMAIL_VERIFIED'
  | 'AUTH.EMAIL_VERIFICATION_FAILED'
  | 'AUTH.LOGIN_SUCCEEDED'
  | 'AUTH.LOGIN_FAILED'
  | 'AUTH.LOGOUT'
  | 'AUTH.PASSWORD_RESET_REQUESTED'
  | 'AUTH.PASSWORD_RESET_COMPLETED'
  | 'AUTH.PASSWORD_CHANGED'
  | 'AUTH.2FA_SETUP_STARTED'
  | 'AUTH.2FA_ENABLED'
  | 'AUTH.2FA_DISABLED'
  | 'AUTH.2FA_FAILED'
  | 'AUTH.RECOVERY_CODE_USED'
  | 'AUTH.RECOVERY_CODES_REGENERATED'
  | 'AUTH.SESSION_REVOKED'
  | 'AUTH.ALL_OTHER_SESSIONS_REVOKED'
  | 'TENANT.CREATED'
  | 'TENANT.UPDATED'
  | 'TENANT.SUSPENDED'
  | 'COMPANY.CREATED'
  | 'COMPANY.UPDATED'
  | 'MEMBERSHIP.CREATED'
  | 'MEMBERSHIP.INVITED'
  | 'MEMBERSHIP.ACTIVATED'
  | 'MEMBERSHIP.SUSPENDED'
  | 'MEMBERSHIP.REMOVED'
  | 'ROLE.ASSIGNED'
  | 'ROLE.REVOKED'
  | 'DOCUMENT.UPLOADED'
  | 'DOCUMENT.CONFIRMED'
  | 'DOCUMENT.DOWNLOADED';

function requestMetadata(request: FastifyRequest): { ip: string; userAgent: string; traceId: string } {
  return {
    ip: request.ip ?? '',
    userAgent: String(request.headers['user-agent'] ?? '').slice(0, 500),
    traceId: request.id,
  };
}

export async function writeAuditEvent(
  db: Queryable,
  action: AuditAction,
  request: FastifyRequest,
  options: {
    userId?: string | null;
    tenantId?: string | null;
    objectType?: string | null;
    objectId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const { ip, userAgent, traceId } = requestMetadata(request);
  await withTransaction(db as Db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [789123]);
    const last = await client.query(
      'SELECT event_hash FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    const previousHash = last.rows[0]?.event_hash ? String(last.rows[0].event_hash) : null;
    const metadata = JSON.stringify(options.metadata ?? {});
    const ipMetadata = JSON.stringify({ ip });
    const canonical = JSON.stringify([
      options.tenantId ?? null,
      options.userId ?? null,
      action,
      options.objectType ?? null,
      options.objectId ?? null,
      metadata,
      ipMetadata,
      userAgent,
      traceId,
      previousHash,
    ]);
    const eventHash = crypto.createHash('sha256').update(canonical).digest('hex');
    await client.query(
      `INSERT INTO audit_events
        (user_id, tenant_id, action, metadata, ip_metadata, user_agent, trace_id,
         object_type, object_id, previous_hash, event_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        options.userId ?? null,
        options.tenantId ?? null,
        action,
        metadata,
        ipMetadata,
        userAgent,
        traceId,
        options.objectType ?? null,
        options.objectId ?? null,
        previousHash,
        eventHash,
      ],
    );
  });
}

export interface AuthAttemptInput {
  purpose: 'login' | 'register' | 'verify_email' | 'password_reset' | 'totp' | 'recovery_code';
  emailNormalized?: string;
  ip?: string;
  success: boolean;
}

export async function recordAuthAttempt(db: Queryable, input: AuthAttemptInput): Promise<void> {
  await db.query(
    `INSERT INTO auth_attempts (purpose, email_normalized, ip, success)
     VALUES ($1, $2, $3, $4)`,
    [input.purpose, input.emailNormalized ?? null, input.ip ?? null, input.success],
  );
}

const MAX_COOLDOWN_SECONDS = 5 * 60;
const THRESHOLD = 5;

/**
 * Bounded progressive cooldown per (purpose, e-mail, IP). A user can never be
 * locked out forever: the delay starts after 5 failures and caps at 5 minutes.
 */
export async function authCooldownSeconds(
  db: Queryable,
  input: { purpose: AuthAttemptInput['purpose']; emailNormalized?: string; ip?: string },
): Promise<number> {
  const where: string[] = ['purpose = $1', 'success = false', 'created_at > now() - interval \'15 minutes\''];
  const values: unknown[] = [input.purpose];
  if (input.emailNormalized) {
    values.push(input.emailNormalized);
    where.push(`email_normalized = $${values.length}`);
  }
  if (input.ip) {
    values.push(input.ip);
    where.push(`ip = $${values.length}`);
  }

  const result = await db.query(
    `SELECT count(*)::int AS failures,
            max(created_at) AS last_failure
     FROM auth_attempts
     WHERE ${where.join(' AND ')}`,
    values,
  );
  const failures = Number(result.rows[0]?.failures ?? 0);
  if (failures < THRESHOLD) return 0;

  const delay = Math.min(MAX_COOLDOWN_SECONDS, 15 * 2 ** (failures - THRESHOLD));
  const lastFailure = result.rows[0]?.last_failure;
  if (!lastFailure) return delay;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(String(lastFailure)).getTime()) / 1000));
  return Math.max(0, delay - elapsed);
}

export async function withTransaction<T>(
  pool: Db,
  callback: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
