import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('database integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'silent',
    });
    app = await buildApp({ config, db: pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('reaches the migrated database through the health endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.database).toBe('up');
  });

  it('has the pgcrypto extension available for future uuid columns', async () => {
    const result = await pool.query('SELECT gen_random_uuid() AS id');
    expect(result.rows[0]?.id).toBeTruthy();
  });
});
