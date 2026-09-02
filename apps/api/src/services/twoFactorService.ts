import type { Queryable } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { hashToken } from '../lib/security';

export interface TotpCredential {
  id: string;
  userId: string;
  secretEncrypted: string;
  confirmedAt: string | null;
}

export async function startTotpSetup(db: Queryable, userId: string, secretEncrypted: string): Promise<void> {
  await db.query(
    `INSERT INTO totp_credentials (user_id, secret_encrypted, confirmed_at)
     VALUES ($1, $2, NULL)`,
    [userId, secretEncrypted],
  );
}

export async function getPendingTotp(db: Queryable, userId: string): Promise<TotpCredential | null> {
  const result = await db.query(
    `SELECT id, user_id, secret_encrypted, confirmed_at
     FROM totp_credentials
     WHERE user_id = $1 AND confirmed_at IS NULL`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: String(row.id),
        userId: String(row.user_id),
        secretEncrypted: String(row.secret_encrypted),
        confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
      }
    : null;
}

export async function getConfirmedTotp(db: Queryable, userId: string): Promise<TotpCredential | null> {
  const result = await db.query(
    `SELECT id, user_id, secret_encrypted, confirmed_at
     FROM totp_credentials
     WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: String(row.id),
        userId: String(row.user_id),
        secretEncrypted: String(row.secret_encrypted),
        confirmedAt: String(row.confirmed_at),
      }
    : null;
}

export async function confirmTotp(db: Queryable, userId: string): Promise<void> {
  const result = await db.query(
    `UPDATE totp_credentials SET confirmed_at = now()
     WHERE user_id = $1 AND confirmed_at IS NULL`,
    [userId],
  );
  if (result.rows.length === 0 && result.rowCount === 0) {
    throw new AppError(ErrorCodes.authInvalidRequest, 'TOTP setup is not pending', 400);
  }
}

export async function disableTotp(db: Queryable, userId: string): Promise<void> {
  await db.query(`DELETE FROM totp_credentials WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
}

export async function replaceRecoveryCodes(
  db: Queryable,
  userId: string,
  rawCodes: string[],
): Promise<void> {
  await db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  for (const code of rawCodes) {
    await db.query(
      `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
      [userId, hashToken(code)],
    );
  }
}

export async function consumeRecoveryCode(db: Queryable, userId: string, rawCode: string): Promise<boolean> {
  const hash = hashToken(rawCode.toUpperCase());
  const result = await db.query(
    `UPDATE recovery_codes SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hash],
  );
  return (result.rowCount ?? 0) > 0;
}
