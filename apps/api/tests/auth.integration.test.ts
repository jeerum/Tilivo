import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { totpForSecret } from '../src/lib/security';

const databaseUrl = process.env.TEST_DATABASE_URL;

const PASSWORD = 'correct horse battery staple';

interface InjectOptions {
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown>;
  cookie?: string;
  csrf?: string;
  ip?: string;
}

function parseTokenFromBody(body: string): string {
  const match = body.match(/[?&]token=([^&\s]+)/);
  if (!match?.[1]) throw new Error(`No token found in body: ${body}`);
  return decodeURIComponent(match[1]);
}

function cookieHeader(response: { cookies?: Array<{ name: string; value: string }> }): string {
  return (response.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
}

describe.skipIf(!databaseUrl)('identity integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let emailCounter = 0;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 't'.repeat(64),
      APP_BASE_URL: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function nextEmail(): string {
    emailCounter += 1;
    return `user${emailCounter}@example.com`;
  }

  async function inject(request: InjectOptions): Promise<{
    status: number;
    body: any;
    cookie: string;
    headers: Record<string, string | undefined>;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (request.ip) headers['x-forwarded-for'] = request.ip;
    if (request.cookie) headers.cookie = request.cookie;
    if (request.csrf) headers['x-csrf-token'] = request.csrf;
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers,
      payload: request.payload,
    });
    let parsed: any;
    try {
      parsed = response.json();
    } catch {
      parsed = null;
    }
    return {
      status: response.statusCode,
      body: parsed,
      cookie: cookieHeader(response),
      headers: response.headers as Record<string, string | undefined>,
    };
  }

  async function lastEmailBody(email: string): Promise<string> {
    const result = await pool.query(
      `SELECT body FROM dev_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const body = result.rows[0]?.body;
    if (!body) throw new Error(`No dev email for ${email}`);
    return String(body);
  }

  async function registerAndVerify(email = nextEmail(), ip = `10.0.${100 + emailCounter}.10`): Promise<string> {
    const register = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD },
      ip,
    });
    expect(register.status).toBe(202);
    const token = parseTokenFromBody(await lastEmailBody(email));
    const verify = await inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token },
      ip,
    });
    expect(verify.status).toBe(200);
    return email;
  }

  async function login(
    email: string,
    password = PASSWORD,
    extra: Record<string, unknown> = {},
    ip = `10.0.${100 + emailCounter}.11`,
  ) {
    return inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password, ...extra },
      ip,
    });
  }

  it('registers, verifies and logs in', async () => {
    const email = await registerAndVerify();
    const beforeVerification = await inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email.toUpperCase(), password: PASSWORD },
      ip: '10.0.0.11',
    });
    expect(beforeVerification.status).toBe(200);
    expect(beforeVerification.body.user.email_verified).toBe(true);
    expect(beforeVerification.body.user.password_hash).toBeUndefined();
    expect(beforeVerification.cookie).toContain('mrjkp_session=');
  });

  it('does not allow login before verification and hides account enumeration', async () => {
    const email = nextEmail();
    const register = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD },
      ip: '10.0.0.20',
    });
    expect(register.status).toBe(202);
    const unverified = await login(email, PASSWORD, {}, '10.0.0.20');
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('AUTH-003');

    const wrongPassword = await login(email, 'wrong password here', {}, '10.0.0.20');
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('AUTH-002');

    const duplicate = await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD },
      ip: '10.0.0.20',
    });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.message).toBe(register.body.message);
  });

  it('rejects an expired verification token', async () => {
    const email = nextEmail();
    await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD },
      ip: '10.0.0.30',
    });
    await pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
      [email],
    );
    const token = parseTokenFromBody(await lastEmailBody(email));
    const result = await inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token },
      ip: '10.0.0.30',
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('AUTH-007');
  });

  it('logs out and rejects the revoked session', async () => {
    const email = await registerAndVerify();
    const loggedIn = await login(email);
    expect(loggedIn.status).toBe(200);

    const me = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: loggedIn.cookie,
      ip: '10.0.0.11',
    });
    expect(me.status).toBe(200);

    const withoutCsrf = await inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookie: loggedIn.cookie,
      ip: '10.0.0.11',
    });
    expect(withoutCsrf.status).toBe(403);
    expect(withoutCsrf.body.error.code).toBe('AUTH-012');

    const logout = await inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookie: loggedIn.cookie,
      csrf: loggedIn.body.csrf_token,
      ip: '10.0.0.11',
    });
    expect(logout.status).toBe(204);

    const afterLogout = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: loggedIn.cookie,
      ip: '10.0.0.11',
    });
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('AUTH-005');
  });

  it('enforces rate limiting after repeated login failures', async () => {
    const email = nextEmail();
    await inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD },
      ip: '10.0.0.40',
    });
    for (let i = 0; i < 5; i += 1) {
      await login(email, 'wrong password value', {}, '10.0.0.40');
    }
    const blocked = await login(email, PASSWORD, {}, '10.0.0.40');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('AUTH-004');
  });

  it('resets password and revokes all sessions', async () => {
    const email = await registerAndVerify();
    const firstLogin = await login(email);
    expect(firstLogin.status).toBe(200);

    const forgot = await inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email },
      ip: '10.0.0.50',
    });
    expect(forgot.status).toBe(202);
    const resetToken = parseTokenFromBody(await lastEmailBody(email));
    const reset = await inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token: resetToken, new_password: 'a new strong password' },
      ip: '10.0.0.50',
    });
    expect(reset.status).toBe(200);

    const oldSessionMe = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: firstLogin.cookie,
      ip: '10.0.0.50',
    });
    expect(oldSessionMe.status).toBe(401);

    const newLogin = await login(email, 'a new strong password', {}, '10.0.0.50');
    expect(newLogin.status).toBe(200);
  });

  it('rejects an expired password reset token', async () => {
    const email = await registerAndVerify();
    await inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email },
      ip: '10.0.0.51',
    });
    await pool.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
      [email],
    );
    const token = parseTokenFromBody(await lastEmailBody(email));
    const result = await inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, new_password: 'another strong password' },
      ip: '10.0.0.51',
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('AUTH-008');
  });

  it('enables 2FA, logs in with TOTP and uses recovery codes once', async () => {
    const email = await registerAndVerify();
    const loggedIn = await login(email);
    expect(loggedIn.status).toBe(200);

    const setup = await inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/setup',
      cookie: loggedIn.cookie,
      csrf: loggedIn.body.csrf_token,
      ip: '10.0.0.60',
    });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(secret).toBeTruthy();

    const code = totpForSecret(secret);
    const confirm = await inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/confirm',
      payload: { code },
      cookie: loggedIn.cookie,
      csrf: loggedIn.body.csrf_token,
      ip: '10.0.0.60',
    });
    expect(confirm.status).toBe(200);
    const recoveryCodes = confirm.body.recovery_codes as string[];
    expect(recoveryCodes).toHaveLength(10);

    const logout = await inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookie: loggedIn.cookie,
      csrf: loggedIn.body.csrf_token,
      ip: '10.0.0.60',
    });
    expect(logout.status).toBe(204);

    const challenge = await login(email, PASSWORD, {}, '10.0.0.61');
    expect(challenge.status).toBe(200);
    expect(challenge.body.requires_two_factor).toBe(true);

    const wrongTotp = await login(
      email,
      PASSWORD,
      { challenge_token: challenge.body.challenge_token, totp_code: '000000' },
      '10.0.0.61',
    );
    expect(wrongTotp.status).toBe(401);
    expect(wrongTotp.body.error.code).toBe('AUTH-010');

    const secondChallenge = await login(email, PASSWORD, {}, '10.0.0.62');
    const totpLogin = await login(
      email,
      PASSWORD,
      { challenge_token: secondChallenge.body.challenge_token, totp_code: totpForSecret(secret) },
      '10.0.0.62',
    );
    expect(totpLogin.status).toBe(200);
    expect(totpLogin.cookie).toContain('mrjkp_session=');

    const logoutSecond = await inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookie: totpLogin.cookie,
      csrf: totpLogin.body.csrf_token,
      ip: '10.0.0.62',
    });
    expect(logoutSecond.status).toBe(204);

    const recoveryChallenge = await login(email, PASSWORD, {}, '10.0.0.63');
    const recoveryLogin = await login(
      email,
      PASSWORD,
      {
        challenge_token: recoveryChallenge.body.challenge_token,
        recovery_code: recoveryCodes[0],
      },
      '10.0.0.63',
    );
    expect(recoveryLogin.status).toBe(200);

    const reuseChallenge = await login(email, PASSWORD, {}, '10.0.0.64');
    const reuse = await login(
      email,
      PASSWORD,
      {
        challenge_token: reuseChallenge.body.challenge_token,
        recovery_code: recoveryCodes[0],
      },
      '10.0.0.64',
    );
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('AUTH-011');
  });

  it('lists and revokes sessions and revokes others', async () => {
    const email = await registerAndVerify();
    const first = await login(email, PASSWORD, {}, '10.0.0.70');
    const second = await login(email, PASSWORD, { remember_me: true }, '10.0.0.71');
    expect(second.status).toBe(200);

    const list = await inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      cookie: second.cookie,
      ip: '10.0.0.71',
    });
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBe(2);
    const otherSession = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect(otherSession).toBeTruthy();

    const revoke = await inject({
      method: 'POST',
      url: `/api/v1/auth/sessions/${otherSession.id}/revoke`,
      cookie: second.cookie,
      csrf: second.body.csrf_token,
      ip: '10.0.0.71',
    });
    expect(revoke.status).toBe(204);

    const firstStillDead = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: first.cookie,
      ip: '10.0.0.71',
    });
    expect(firstStillDead.status).toBe(401);
  });

  it('changes password and keeps only the current session', async () => {
    const email = await registerAndVerify();
    const first = await login(email, PASSWORD, {}, '10.0.0.80');
    const second = await login(email, PASSWORD, {}, '10.0.0.81');

    const change = await inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      payload: { current_password: PASSWORD, new_password: 'changed strong password' },
      cookie: second.cookie,
      csrf: second.body.csrf_token,
      ip: '10.0.0.81',
    });
    expect(change.status).toBe(200);

    const firstMe = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: first.cookie,
      ip: '10.0.0.81',
    });
    expect(firstMe.status).toBe(401);

    const secondMe = await inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookie: second.cookie,
      ip: '10.0.0.81',
    });
    expect(secondMe.status).toBe(200);
  });

  it('stores only hashes for tokens and passwords are not exposed', async () => {
    const email = await registerAndVerify();
    const users = await pool.query(
      `SELECT password_hash, email_normalized FROM users WHERE email_normalized = $1`,
      [email],
    );
    expect(users.rows[0]?.password_hash).toMatch(/^\$argon2/);

    const tokens = await pool.query(
      `SELECT token_hash FROM email_verification_tokens
       WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
      [email],
    );
    expect(tokens.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
