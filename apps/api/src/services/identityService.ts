import type { Db, Queryable } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { hashToken, newTokenPair } from '../lib/security';
import { withTransaction } from './audit';

export interface UserRecord {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  emailVerifiedAt: string | null;
  status: 'ACTIVE' | 'DISABLED';
  totpEnabled: boolean;
  createdAt: string;
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    emailNormalized: String(row.email_normalized),
    passwordHash: String(row.password_hash),
    emailVerifiedAt: row.email_verified_at ? String(row.email_verified_at) : null,
    status: row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    totpEnabled: Boolean(row.totp_enabled),
    createdAt: String(row.created_at),
  };
}

const USER_SELECT = `
  SELECT u.id, u.email, u.email_normalized, u.password_hash, u.email_verified_at,
         u.status, u.created_at,
         EXISTS (SELECT 1 FROM totp_credentials tc
                 WHERE tc.user_id = u.id AND tc.confirmed_at IS NOT NULL) AS totp_enabled
  FROM users u
`;

export async function findUserByEmail(db: Queryable, emailNormalized: string): Promise<UserRecord | null> {
  const result = await db.query(`${USER_SELECT} WHERE u.email_normalized = $1`, [emailNormalized]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRecord | null> {
  const result = await db.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function createUser(
  db: Db,
  input: { email: string; emailNormalized: string; passwordHash: string },
): Promise<UserRecord> {
  return withTransaction(db, async (client) => {
    const result = await client.query(
      `INSERT INTO users (email, email_normalized, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, email_normalized, password_hash, email_verified_at, status, created_at`,
      [input.email, input.emailNormalized, input.passwordHash],
    );
    return mapUser({ ...result.rows[0], totp_enabled: false });
  });
}

export async function issueEmailVerificationToken(
  db: Db,
  userId: string,
  ttlHours = 24,
): Promise<string> {
  const { token, hash } = newTokenPair();
  await db.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [userId, hash, String(ttlHours)],
  );
  return token;
}

export async function verifyEmailWithToken(db: Db, rawToken: string): Promise<UserRecord> {
  const hash = hashToken(rawToken);
  return withTransaction(db, async (client) => {
    const tokenResult = await client.query(
      `SELECT evt.id, evt.user_id, u.email_normalized
       FROM email_verification_tokens evt
       JOIN users u ON u.id = evt.user_id
       WHERE evt.token_hash = $1
         AND evt.used_at IS NULL
         AND evt.expires_at > now()`,
      [hash],
    );
    const token = tokenResult.rows[0];
    if (!token) {
      throw new AppError(
        ErrorCodes.authVerificationTokenInvalid,
        'Verification token is invalid or expired',
        400,
      );
    }
    const claimed = await client.query(
      `UPDATE email_verification_tokens SET used_at = now()
       WHERE id = $1 AND used_at IS NULL
       RETURNING id`,
      [token.id],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCodes.authVerificationTokenInvalid,
        'Verification token is invalid or expired',
        400,
      );
    }
    await client.query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1`, [
      token.user_id,
    ]);
    const user = await findUserById(client, String(token.user_id));
    if (!user) throw new AppError(ErrorCodes.authInvalidRequest, 'User no longer exists', 500);
    return user;
  });
}

export async function issuePasswordResetToken(
  db: Db,
  userId: string,
  ttlMinutes = 30,
): Promise<string> {
  const { token, hash } = newTokenPair();
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [userId, hash, String(ttlMinutes)],
  );
  return token;
}

export async function resetPasswordWithToken(
  db: Db,
  rawToken: string,
  newPasswordHash: string,
): Promise<UserRecord> {
  const hash = hashToken(rawToken);
  return withTransaction(db, async (client) => {
    const tokenResult = await client.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > now()`,
      [hash],
    );
    const token = tokenResult.rows[0];
    if (!token) {
      throw new AppError(
        ErrorCodes.authResetTokenInvalid,
        'Password reset token is invalid or expired',
        400,
      );
    }
    const claimed = await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE id = $1 AND used_at IS NULL
       RETURNING id`,
      [token.id],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCodes.authResetTokenInvalid,
        'Password reset token is invalid or expired',
        400,
      );
    }
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [newPasswordHash, token.user_id],
    );
    await client.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [token.user_id],
    );
    const user = await findUserById(client, String(token.user_id));
    if (!user) throw new AppError(ErrorCodes.authInvalidRequest, 'User no longer exists', 500);
    return user;
  });
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
