import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  otpauthUri,
  verifyPassword,
  verifyTotp,
} from '../lib/security';
import { authCooldownSeconds, recordAuthAttempt, writeAuditEvent } from '../services/audit';
import type { EmailProvider } from '../services/emailProvider';
import {
  createUser,
  findUserByEmail,
  findUserById,
  isUniqueViolation,
  issueEmailVerificationToken,
  issuePasswordResetToken,
  resetPasswordWithToken,
  verifyEmailWithToken,
  type UserRecord,
} from '../services/identityService';
import {
  challengeForUser,
  createSession,
  findSessionByToken,
  listSessions,
  requireActiveSession,
  revokeOtherSessions,
  revokeSessionById,
  updateSessionSeen,
  type NewSession,
  type SessionRecord,
} from '../services/sessionService';
import {
  confirmTotp,
  consumeRecoveryCode,
  disableTotp,
  getConfirmedTotp,
  getPendingTotp,
  replaceRecoveryCodes,
  startTotpSetup,
} from '../services/twoFactorService';

interface AuthRouteOptions {
  db: Db;
  emailProvider: EmailProvider;
  config: AppConfig;
}

interface RegisterBody {
  email?: string;
  password?: string;
}

interface LoginBody extends RegisterBody {
  remember_me?: boolean;
  challenge_token?: string;
  totp_code?: string;
  recovery_code?: string;
}

interface TokenBody {
  token?: string;
}

interface NewPasswordBody extends TokenBody {
  new_password?: string;
}

interface CodeBody {
  code?: string;
}

const NO_CSRF_PATHS = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/password/forgot',
  '/api/v1/auth/password/reset',
  '/api/v1/auth/email/verify',
]);

function validateEmail(email: string): string {
  if (!email || !isValidEmail(email)) {
    throw new AppError(ErrorCodes.authInvalidRequest, 'A valid email address is required', 400);
  }
  return normalizeEmail(email);
}

function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new AppError(
      ErrorCodes.authPasswordPolicy,
      'Password must be between 12 and 128 characters',
      400,
    );
  }
  return password;
}

function validateToken(token: string): string {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new AppError(ErrorCodes.authInvalidRequest, 'Token is required', 400);
  }
  return token;
}

function validateTotpCode(code: string): string {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new AppError(ErrorCodes.authTwoFactorInvalid, 'TOTP code must be 6 digits', 400);
  }
  return code;
}

function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  session: NewSession,
  csrfToken: string,
  rememberMe: boolean,
): void {
  const ttlSeconds = rememberMe ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
  reply.setCookie(config.SESSION_COOKIE_NAME, session.sessionToken, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    maxAge: ttlSeconds,
  });
  reply.setCookie(config.CSRF_COOKIE_NAME, csrfToken, {
    path: '/',
    httpOnly: false,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    maxAge: ttlSeconds,
  });
}

function clearCookies(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
  reply.clearCookie(config.CSRF_COOKIE_NAME, { path: '/' });
}

function publicUser(user: UserRecord): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    email_verified: Boolean(user.emailVerifiedAt),
    totp_enabled: user.totpEnabled,
    created_at: user.createdAt,
  };
}

async function loadActiveUser(db: Db, userId: string): Promise<UserRecord> {
  const user = await findUserById(db, userId);
  if (!user) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Session is invalid', 401);
  }
  if (user.status === 'DISABLED') {
    throw new AppError(ErrorCodes.authAccountDisabled, 'Account is disabled', 403);
  }
  return user;
}

async function getCurrentSession(
  db: Db,
  request: FastifyRequest,
  config: AppConfig,
): Promise<{ session: SessionRecord; csrfToken: string }> {
  const rawSession = request.cookies[config.SESSION_COOKIE_NAME];
  const csrfToken = request.cookies[config.CSRF_COOKIE_NAME] ?? '';
  if (!rawSession) {
    throw new AppError(ErrorCodes.authSessionInvalid, 'Authentication required', 401);
  }
  const session = requireActiveSession(await findSessionByToken(db, rawSession));
  await updateSessionSeen(db, session.id);
  return { session, csrfToken };
}

function requestIp(request: FastifyRequest): string {
  return request.ip ?? '';
}

function requestUserAgent(request: FastifyRequest): string {
  return String(request.headers['user-agent'] ?? '').slice(0, 500);
}

async function sendVerificationEmail(
  emailProvider: EmailProvider,
  config: AppConfig,
  email: string,
  token: string,
): Promise<void> {
  const link = `${config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await emailProvider.send({
    to: email,
    subject: 'Verify your email',
    text: `Welcome to Tilivo.\n\nVerify your email by opening this link:\n${link}\n\nThis link expires in 24 hours.`,
  });
}

async function sendPasswordResetEmail(
  emailProvider: EmailProvider,
  config: AppConfig,
  email: string,
  token: string,
): Promise<void> {
  const link = `${config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await emailProvider.send({
    to: email,
    subject: 'Reset your password',
    text: `We received a password reset request.\n\nReset your password here:\n${link}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.`,
  });
}

async function assertNotRateLimited(
  db: Db,
  request: FastifyRequest,
  purpose: 'login' | 'register' | 'verify_email' | 'password_reset' | 'totp' | 'recovery_code',
  emailNormalized?: string,
): Promise<void> {
  const cooldown = await authCooldownSeconds(db, {
    purpose,
    emailNormalized,
    ip: requestIp(request),
  });
  if (cooldown > 0) {
    throw new AppError(
      ErrorCodes.authRateLimited,
      'Too many attempts. Please try again later.',
      429,
    );
  }
}

export async function authRoutes(app: FastifyInstance, options: AuthRouteOptions): Promise<void> {
  const { db, emailProvider, config } = options;

  app.addHook('onRequest', async (request) => {
    const method = request.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    if (NO_CSRF_PATHS.has(request.url.split('?')[0] ?? '')) return;

    const rawSession = request.cookies?.[config.SESSION_COOKIE_NAME];
    if (!rawSession) return;
    const session = await findSessionByToken(db, rawSession);
    if (!session) return;
    const headerCsrf = request.headers['x-csrf-token'];
    const cookieCsrf = request.cookies?.[config.CSRF_COOKIE_NAME] ?? '';
    if (
      typeof headerCsrf !== 'string' ||
      !cookieCsrf ||
      hashToken(headerCsrf) !== session.csrfTokenHash
    ) {
      throw new AppError(ErrorCodes.authCsrfInvalid, 'CSRF validation failed', 403);
    }
  });

  app.post<{ Body: RegisterBody }>(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const email = validateEmail(request.body?.email ?? '');
      const password = validatePassword(request.body?.password ?? '');
      await assertNotRateLimited(db, request, 'register', email);

      const existing = await findUserByEmail(db, email);
      if (existing) {
        // Deliberately generic response for both new and existing accounts.
        await recordAuthAttempt(db, {
          purpose: 'register',
          emailNormalized: email,
          ip: requestIp(request),
          success: Boolean(existing),
        });
        return reply.code(202).send({ message: 'Registration accepted. Check your email.' });
      }

      const passwordHash = await hashPassword(password);
      try {
        const user = await createUser(db, {
          email,
          emailNormalized: email,
          passwordHash,
        });
        const verificationToken = await issueEmailVerificationToken(db, user.id);
        await sendVerificationEmail(emailProvider, config, user.email, verificationToken);
        await writeAuditEvent(db, 'AUTH.REGISTERED', request, { userId: user.id });
        await writeAuditEvent(db, 'AUTH.EMAIL_VERIFICATION_REQUESTED', request, { userId: user.id });
        await recordAuthAttempt(db, {
          purpose: 'register',
          emailNormalized: email,
          ip: requestIp(request),
          success: true,
        });
        return reply.code(202).send({ message: 'Registration accepted. Check your email.' });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(202).send({ message: 'Registration accepted. Check your email.' });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: TokenBody }>(
    '/api/v1/auth/email/verify',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const token = validateToken(request.body?.token ?? '');
      try {
        const user = await verifyEmailWithToken(db, token);
        await writeAuditEvent(db, 'AUTH.EMAIL_VERIFIED', request, { userId: user.id });
        return reply.send({ message: 'Email verified', email: user.email });
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCodes.authVerificationTokenInvalid) {
          await writeAuditEvent(db, 'AUTH.EMAIL_VERIFICATION_FAILED', request);
        }
        throw error;
      }
    },
  );

  app.post<{ Body: RegisterBody }>(
    '/api/v1/auth/email/resend',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const email = validateEmail(request.body?.email ?? '');
      const user = await findUserByEmail(db, email);
      if (user && !user.emailVerifiedAt) {
        const token = await issueEmailVerificationToken(db, user.id);
        await sendVerificationEmail(emailProvider, config, user.email, token);
        await writeAuditEvent(db, 'AUTH.EMAIL_VERIFICATION_REQUESTED', request, { userId: user.id });
      }
      return reply.code(202).send({ message: 'If the account exists, a verification email was sent.' });
    },
  );

  app.post<{ Body: LoginBody }>(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const email = validateEmail(request.body?.email ?? '');
      const password = request.body?.password ?? '';
      await assertNotRateLimited(db, request, 'login', email);

      const user = await findUserByEmail(db, email);
      if (!user || user.status === 'DISABLED') {
        await recordAuthAttempt(db, {
          purpose: 'login',
          emailNormalized: email,
          ip: requestIp(request),
          success: false,
        });
        await writeAuditEvent(db, 'AUTH.LOGIN_FAILED', request, { metadata: { email } });
        throw new AppError(ErrorCodes.authInvalidCredentials, 'Invalid email or password', 401);
      }

      const passwordOk = await verifyPassword(password, user.passwordHash);
      if (!passwordOk) {
        await recordAuthAttempt(db, {
          purpose: 'login',
          emailNormalized: email,
          ip: requestIp(request),
          success: false,
        });
        await writeAuditEvent(db, 'AUTH.LOGIN_FAILED', request, { userId: user.id });
        throw new AppError(ErrorCodes.authInvalidCredentials, 'Invalid email or password', 401);
      }

      if (!user.emailVerifiedAt) {
        throw new AppError(ErrorCodes.authEmailNotVerified, 'Email is not verified', 403);
      }

      if (user.totpEnabled) {
        const { challenge_token: challengeTokenRaw, totp_code: totpCode, recovery_code: recoveryCode } =
          request.body ?? {};

        if (!totpCode && !recoveryCode) {
          const challenge = await challengeForUser(db, user.id);
          return reply.send({
            requires_two_factor: true,
            challenge_token: challenge.token,
            expires_in_seconds: 300,
          });
        }

        const challengeToken = validateToken(challengeTokenRaw ?? '');
        const challengeResult = await db.query(
          `SELECT id, user_id FROM two_factor_challenges
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
          [hashToken(challengeToken)],
        );
        const challenge = challengeResult.rows[0];
        if (!challenge || String(challenge.user_id) !== user.id) {
          throw new AppError(ErrorCodes.authInvalidRequest, 'Login challenge is invalid', 400);
        }

        const credential = await getConfirmedTotp(db, user.id);
        let twoFactorOk = false;
        let usedRecovery = false;
        if (credential && totpCode) {
          const secret = decryptSecret(credential.secretEncrypted, config.TOTP_ENCRYPTION_KEY);
          twoFactorOk = verifyTotp(secret, validateTotpCode(totpCode));
        }
        if (!twoFactorOk && recoveryCode) {
          usedRecovery = await consumeRecoveryCode(db, user.id, recoveryCode.toUpperCase());
          twoFactorOk = usedRecovery;
        }
        if (!twoFactorOk) {
          await recordAuthAttempt(db, {
            purpose: totpCode ? 'totp' : 'recovery_code',
            emailNormalized: email,
            ip: requestIp(request),
            success: false,
          });
          await writeAuditEvent(db, 'AUTH.2FA_FAILED', request, { userId: user.id });
          throw new AppError(
            totpCode ? ErrorCodes.authTwoFactorInvalid : ErrorCodes.authRecoveryCodeInvalid,
            'Invalid two-factor code',
            401,
          );
        }
        await db.query(`UPDATE two_factor_challenges SET used_at = now() WHERE id = $1`, [challenge.id]);
        if (usedRecovery) {
          await writeAuditEvent(db, 'AUTH.RECOVERY_CODE_USED', request, { userId: user.id });
        }
        const session = await createSession(db, {
          userId: user.id,
          rememberMe: Boolean(request.body?.remember_me),
          ip: requestIp(request),
          userAgent: requestUserAgent(request),
        });
        setSessionCookies(reply, config, session, session.csrfToken, Boolean(request.body?.remember_me));
        await writeAuditEvent(db, 'AUTH.LOGIN_SUCCEEDED', request, { userId: user.id });
        return reply.send({
          user: publicUser(user),
          session: { id: session.sessionId, expires_at: session.expiresAt.toISOString() },
          csrf_token: session.csrfToken,
        });
      }

      const session = await createSession(db, {
        userId: user.id,
        rememberMe: Boolean(request.body?.remember_me),
        ip: requestIp(request),
        userAgent: requestUserAgent(request),
      });
      setSessionCookies(reply, config, session, session.csrfToken, Boolean(request.body?.remember_me));
      await recordAuthAttempt(db, {
        purpose: 'login',
        emailNormalized: email,
        ip: requestIp(request),
        success: true,
      });
      await writeAuditEvent(db, 'AUTH.LOGIN_SUCCEEDED', request, { userId: user.id });
      return reply.send({
        user: publicUser(user),
        session: { id: session.sessionId, expires_at: session.expiresAt.toISOString() },
        csrf_token: session.csrfToken,
      });
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const { session } = await getCurrentSession(db, request, config);
    await revokeSessionById(db, session.id, session.userId);
    await writeAuditEvent(db, 'AUTH.LOGOUT', request, { userId: session.userId });
    clearCookies(reply, config);
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (request) => {
    const { session } = await getCurrentSession(db, request, config);
    const user = await loadActiveUser(db, session.userId);
    return { user: publicUser(user) };
  });

  app.get('/api/v1/auth/sessions', async (request) => {
    const { session } = await getCurrentSession(db, request, config);
    const rows = await listSessions(db, session.userId);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.id === session.id,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
        last_seen_at: row.lastSeenAt,
        revoked_at: row.revokedAt,
        remember_me: row.rememberMe,
        user_agent: row.userAgent,
      })),
    };
  });

  app.post('/api/v1/auth/sessions/revoke-others', async (request, reply) => {
    const { session } = await getCurrentSession(db, request, config);
    await revokeOtherSessions(db, session.userId, session.id);
    await writeAuditEvent(db, 'AUTH.ALL_OTHER_SESSIONS_REVOKED', request, { userId: session.userId });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/auth/sessions/:id/revoke',
    async (request, reply) => {
      const { session } = await getCurrentSession(db, request, config);
      await revokeSessionById(db, request.params.id, session.userId);
      await writeAuditEvent(db, 'AUTH.SESSION_REVOKED', request, { userId: session.userId });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: RegisterBody }>(
    '/api/v1/auth/password/forgot',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const email = validateEmail(request.body?.email ?? '');
      const user = await findUserByEmail(db, email);
      if (user) {
        const token = await issuePasswordResetToken(db, user.id);
        await sendPasswordResetEmail(emailProvider, config, user.email, token);
        await writeAuditEvent(db, 'AUTH.PASSWORD_RESET_REQUESTED', request, { userId: user.id });
      }
      return reply.code(202).send({
        message: 'If the account exists, a password reset email was sent.',
      });
    },
  );

  app.post<{ Body: NewPasswordBody }>(
    '/api/v1/auth/password/reset',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const token = validateToken(request.body?.token ?? '');
      const newPassword = validatePassword(request.body?.new_password ?? '');
      const passwordHash = await hashPassword(newPassword);
      const user = await resetPasswordWithToken(db, token, passwordHash);
      await writeAuditEvent(db, 'AUTH.PASSWORD_RESET_COMPLETED', request, { userId: user.id });
      return reply.send({ message: 'Password has been reset. Please sign in.' });
    },
  );

  app.post<{ Body: { current_password?: string; new_password?: string } }>(
    '/api/v1/auth/password/change',
    async (request, reply) => {
      const { session } = await getCurrentSession(db, request, config);
      const user = await loadActiveUser(db, session.userId);
      const currentPassword = request.body?.current_password ?? '';
      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new AppError(ErrorCodes.authInvalidCredentials, 'Current password is incorrect', 401);
      }
      const newPassword = validatePassword(request.body?.new_password ?? '');
      if (await verifyPassword(newPassword, user.passwordHash)) {
        throw new AppError(
          ErrorCodes.authPasswordPolicy,
          'New password must differ from the current password',
          400,
        );
      }
      const passwordHash = await hashPassword(newPassword);
      await db.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
        passwordHash,
        user.id,
      ]);
      await revokeOtherSessions(db, user.id, session.id);
      await writeAuditEvent(db, 'AUTH.PASSWORD_CHANGED', request, { userId: user.id });
      return reply.send({ message: 'Password changed. Other sessions were signed out.' });
    },
  );

  app.post('/api/v1/auth/2fa/setup', async (request, reply) => {
    const { session } = await getCurrentSession(db, request, config);
    const user = await loadActiveUser(db, session.userId);
    if (user.totpEnabled) {
      throw new AppError(ErrorCodes.authInvalidRequest, 'Two-factor authentication is already enabled', 400);
    }
    const pending = await getPendingTotp(db, user.id);
    if (pending) {
      await db.query(`DELETE FROM totp_credentials WHERE user_id = $1`, [user.id]);
    }
    const secret = generateTotpSecret();
    const secretEncrypted = encryptSecret(secret, config.TOTP_ENCRYPTION_KEY);
    await startTotpSetup(db, user.id, secretEncrypted);
    await writeAuditEvent(db, 'AUTH.2FA_SETUP_STARTED', request, { userId: user.id });
    return reply.send({
      secret,
      otpauth_uri: otpauthUri(secret, user.email),
    });
  });

  app.post<{ Body: CodeBody }>(
    '/api/v1/auth/2fa/confirm',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { session } = await getCurrentSession(db, request, config);
      const user = await loadActiveUser(db, session.userId);
      const pending = await getPendingTotp(db, user.id);
      if (!pending) {
        throw new AppError(ErrorCodes.authInvalidRequest, 'No pending two-factor setup', 400);
      }
      const code = validateTotpCode(request.body?.code ?? '');
      const secret = decryptSecret(pending.secretEncrypted, config.TOTP_ENCRYPTION_KEY);
      if (!verifyTotp(secret, code)) {
        await writeAuditEvent(db, 'AUTH.2FA_FAILED', request, { userId: user.id });
        throw new AppError(ErrorCodes.authTwoFactorInvalid, 'Invalid TOTP code', 401);
      }
      await confirmTotp(db, user.id);
      const rawCodes = generateRecoveryCodes();
      await replaceRecoveryCodes(db, user.id, rawCodes);
      await writeAuditEvent(db, 'AUTH.2FA_ENABLED', request, { userId: user.id });
      return reply.send({
        message: 'Two-factor authentication enabled',
        recovery_codes: rawCodes,
      });
    },
  );

  app.post<{ Body: CodeBody }>(
    '/api/v1/auth/2fa/disable',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { session } = await getCurrentSession(db, request, config);
      const user = await loadActiveUser(db, session.userId);
      const credential = await getConfirmedTotp(db, user.id);
      if (!credential) {
        throw new AppError(ErrorCodes.authInvalidRequest, 'Two-factor authentication is not enabled', 400);
      }
      const code = request.body?.code ?? '';
      const secret = decryptSecret(credential.secretEncrypted, config.TOTP_ENCRYPTION_KEY);
      const ok = verifyTotp(secret, code) || (await consumeRecoveryCode(db, user.id, code.toUpperCase()));
      if (!ok) {
        await writeAuditEvent(db, 'AUTH.2FA_FAILED', request, { userId: user.id });
        throw new AppError(ErrorCodes.authTwoFactorInvalid, 'Invalid code', 401);
      }
      await disableTotp(db, user.id);
      await writeAuditEvent(db, 'AUTH.2FA_DISABLED', request, { userId: user.id });
      return reply.send({ message: 'Two-factor authentication disabled' });
    },
  );

  app.post<{ Body: CodeBody }>(
    '/api/v1/auth/2fa/recovery-codes',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { session } = await getCurrentSession(db, request, config);
      const user = await loadActiveUser(db, session.userId);
      const credential = await getConfirmedTotp(db, user.id);
      if (!credential) {
        throw new AppError(ErrorCodes.authInvalidRequest, 'Two-factor authentication is not enabled', 400);
      }
      const code = validateTotpCode(request.body?.code ?? '');
      const secret = decryptSecret(credential.secretEncrypted, config.TOTP_ENCRYPTION_KEY);
      if (!verifyTotp(secret, code)) {
        await writeAuditEvent(db, 'AUTH.2FA_FAILED', request, { userId: user.id });
        throw new AppError(ErrorCodes.authTwoFactorInvalid, 'Invalid TOTP code', 401);
      }
      const rawCodes = generateRecoveryCodes();
      await replaceRecoveryCodes(db, user.id, rawCodes);
      await writeAuditEvent(db, 'AUTH.RECOVERY_CODES_REGENERATED', request, { userId: user.id });
      return reply.send({ recovery_codes: rawCodes });
    },
  );
}
