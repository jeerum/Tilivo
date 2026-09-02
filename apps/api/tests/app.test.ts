import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config/env';
import type { Db } from '../src/db/pool';
import { ErrorCodes } from '../src/lib/errors';

const openApps: FastifyInstance[] = [];

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '3101',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    LOG_LEVEL: 'silent',
    EXPOSE_DOCS: 'false',
    TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  });
}

const okDb = {
  query: async () => ({ rows: [{ ok: 1 }] }),
} as unknown as Db;

const downDb = {
  query: async () => {
    throw new Error('connection refused');
  },
} as unknown as Db;

async function makeApp(db: Db): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), db });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop();
    await app?.close();
  }
});

describe('health endpoint', () => {
  it('returns 200 with database up when the db responds', async () => {
    const app = await makeApp(okDb);
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'up' },
      version: '0.2.0',
      environment: 'test',
    });
  });

  it('propagates and returns the trace id', async () => {
    const app = await makeApp(okDb);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-trace-id': 'trace-abc-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-trace-id']).toBe('trace-abc-123');
    expect(response.json().trace_id).toBe('trace-abc-123');
  });

  it('generates a trace id when the caller does not provide one', async () => {
    const app = await makeApp(okDb);
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.headers['x-trace-id']).toBeTruthy();
    expect(response.json().trace_id).toBe(response.headers['x-trace-id']);
  });

  it('returns 503 with an error id when the database is down', async () => {
    const app = await makeApp(downDb);
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('down');
    expect(body.error.code).toBe(ErrorCodes.databaseUnreachable);
    expect(body.error.trace_id).toBeTruthy();
  });
});

describe('route and error handling', () => {
  it('exposes service info and api v1 base', async () => {
    const app = await makeApp(okDb);
    const root = await app.inject({ method: 'GET', url: '/' });
    const api = await app.inject({ method: 'GET', url: '/api/v1' });

    expect(root.statusCode).toBe(200);
    expect(root.json().service).toBe('mrjkp-accounting-api');
    expect(api.statusCode).toBe(200);
    expect(api.json().api).toBe('v1');
  });

  it('returns a structured 404 with trace id', async () => {
    const app = await makeApp(okDb);
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(ErrorCodes.notFound);
    expect(response.headers['x-trace-id']).toBeTruthy();
  });

  it('returns structured errors for unknown failures without leaking internals', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('sensitive internals: SELECT * FROM credentials');
      },
    } as unknown as Db;
    const app = await buildApp({
      config: testConfig({ NODE_ENV: 'production' }),
      db: failingDb,
    });
    openApps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).not.toContain('credentials');
    expect(response.json().version).toBeUndefined();
    expect(response.json().environment).toBeUndefined();
  });

  it('hides environment and version details from health in production', async () => {
    const app = await buildApp({
      config: testConfig({ NODE_ENV: 'production' }),
      db: okDb,
    });
    openApps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'up' },
    });
    expect(response.json().version).toBeUndefined();
    expect(response.json().environment).toBeUndefined();
    expect(response.json().time).toBeUndefined();
    expect(response.json().trace_id).toBeTruthy();
  });
});
