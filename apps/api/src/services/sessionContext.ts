import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { findUserById, type UserRecord } from './identityService';
import { findSessionByToken, requireActiveSession, updateSessionSeen } from './sessionService';

export async function resolveSessionUser(
  db: Db,
  request: FastifyRequest,
  config: AppConfig,
): Promise<{ user: UserRecord; sessionId: string }> {
  const rawSession = request.cookies?.[config.SESSION_COOKIE_NAME];
  if (!rawSession) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Authentication required', 401);
  }
  const session = requireActiveSession(await findSessionByToken(db, rawSession));
  await updateSessionSeen(db, session.id);
  const user = await findUserById(db, session.userId);
  if (!user) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Session is invalid', 401);
  }
  if (user.status === 'DISABLED') {
    throw new AppError(ErrorCodes.authAccountDisabled, 'Account is disabled', 403);
  }
  return { user, sessionId: session.id };
}
