import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('secret logging integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let logOutput = '';
  let logStream: PassThrough;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    logStream = new PassThrough();
    logStream.on('data', (chunk) => {
      logOutput += String(chunk);
    });
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'info',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool, loggerStream: logStream });
  });

  afterAll(async () => {
    await app.close();
    logStream.destroy();
    await pool.end();
  });

  it('does not write marker passwords, tokens or secrets into logs', async () => {
    const markerPassword = 'TEST_PASSWORD_DO_NOT_LOG_VALUE';
    const markerToken = 'TEST_TOKEN_DO_NOT_LOG_VALUE';
    const markerSecret = 'TEST_TOTP_SECRET_DO_NOT_LOG';

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'logging-check@example.com', password: markerPassword },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'missing-logging-check@example.com', password: markerPassword },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      headers: { 'content-type': 'application/json' },
      payload: { token: markerToken },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/setup',
      headers: { 'content-type': 'application/json' },
      payload: { code: '123456', secret: markerSecret },
    });

    expect(logOutput.length).toBeGreaterThan(0);
    expect(logOutput).not.toContain(markerPassword);
    expect(logOutput).not.toContain(markerToken);
    expect(logOutput).not.toContain(markerSecret);
  });
});
