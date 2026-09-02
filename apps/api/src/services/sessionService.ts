import type { Db, Queryable } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { hashToken, newTokenPair } from '../lib/security';

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  rememberMe: boolean;
  userAgent: string;
}

export interface NewSession {
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export const REGULAR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const REMEMBER_ME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    csrfTokenHash: String(row.csrf_token_hash),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    rememberMe: Boolean(row.remember_me),
    userAgent: String(row.user_agent_metadata ?? ''),
  };
}

export async function createSession(
  db: Queryable,
  input: {
    userId: string;
    rememberMe: boolean;
    ip?: string;
    userAgent?: string;
  },
): Promise<NewSession> {
  const { token: sessionToken, hash: tokenHash } = newTokenPair();
  const { token: csrfToken, hash: csrfTokenHash } = newTokenPair();
  const ttl = input.rememberMe ? REMEMBER_ME_TTL_MS : REGULAR_SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  const result = await db.query(
    `INSERT INTO sessions
       (user_id, token_hash, csrf_token_hash, expires_at, remember_me, ip_metadata, user_agent_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.userId,
      tokenHash,
      csrfTokenHash,
      expiresAt.toISOString(),
      input.rememberMe,
      JSON.stringify({ ip: input.ip ?? '' }),
      input.userAgent ?? '',
    ],
  );

  return {
    sessionId: String(result.rows[0]!.id),
    sessionToken,
    csrfToken,
    expiresAt,
  };
}

export async function findSessionByToken(db: Queryable, sessionToken: string): Promise<SessionRecord | null> {
  const result = await db.query(
    `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at,
            last_seen_at, revoked_at, remember_me, user_agent_metadata
     FROM sessions
     WHERE token_hash = $1`,
    [hashToken(sessionToken)],
  );
  const row = result.rows[0];
  return row ? mapSession(row) : null;
}

export async function updateSessionSeen(db: Queryable, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_seen_at = now()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
    [sessionId],
  );
}

export async function revokeSessionById(db: Queryable, sessionId: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeOtherSessions(db: Queryable, userId: string, keepSessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, keepSessionId],
  );
}

export async function listSessions(db: Queryable, userId: string): Promise<SessionRecord[]> {
  const result = await db.query(
    `SELECT id, user_id, token_hash, csrf_token_hash, created_at, expires_at,
            last_seen_at, revoked_at, remember_me, user_agent_metadata
     FROM sessions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map((row) => mapSession(row));
}

export function requireActiveSession(session: SessionRecord | null, now = new Date()): SessionRecord {
  if (!session) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Session is invalid', 401);
  }
  if (session.revokedAt) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Session is invalid', 401);
  }
  if (new Date(session.expiresAt).getTime() <= now.getTime()) {
    throw new AppError(ErrorCodes.authSessionExpired, 'Session has expired', 401);
  }
  return session;
}

export async function challengeForUser(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = newTokenPair(24);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(
    `INSERT INTO two_factor_challenges (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}
