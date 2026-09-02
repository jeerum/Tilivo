import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import {
  appendOutbox,
  processOutbox,
  receiveInboxEvent,
} from '../src/services/integrationQueue';

const databaseUrl = process.env.TEST_DATABASE_URL;
const workerDatabaseUrl = process.env.WORKER_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl || !workerDatabaseUrl)('v0.4 platform integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    workerPool = createPool(workerDatabaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
  });

  it('runtime role cannot update or delete audit events and hash chain links events', async () => {
    await expect(pool.query('UPDATE audit_events SET metadata = metadata WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(pool.query('DELETE FROM audit_events WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    const rows = await pool.query(
      'SELECT event_hash, previous_hash FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 2',
    );
    if (rows.rows.length >= 2) {
      expect(String(rows.rows[0]!.previous_hash)).toBe(String(rows.rows[1]!.event_hash));
    }
    if (rows.rows[0]) {
      expect(String(rows.rows[0]!.event_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('inbox is idempotent by provider/external id', async () => {
    const first = await receiveInboxEvent(workerPool, {
      tenantId: null,
      provider: 'test',
      eventType: 'TEST.EVENT',
      externalEventId: 'same-external-1',
      payload: { value: 1 },
    });
    const second = await receiveInboxEvent(workerPool, {
      tenantId: null,
      provider: 'test',
      eventType: 'TEST.EVENT',
      externalEventId: 'same-external-1',
      payload: { value: 2 },
    });
    expect(first).toBe('inserted');
    expect(second).toBe('duplicate');
  });

  it('outbox append then worker claims and processes', async () => {
    const tenants = await pool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
    if (!tenants.rows[0]) return;
    const tenantId = String(tenants.rows[0].id);
    const outboxId = await appendOutbox(workerPool, tenantId, {
      eventType: 'TEST.OUTBOX',
      aggregateType: 'TEST',
      aggregateId: tenantId,
      payload: { value: 42 },
    });
    let seen = false;
    const processed = await processOutbox(workerPool, async (event) => {
      if (event.id === outboxId) seen = true;
    }, 10);
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(seen).toBe(true);
    const status = await workerPool.query(
      'SELECT status FROM integration_outbox WHERE id = $1',
      [outboxId],
    );
    expect(String(status.rows[0]!.status)).toBe('PROCESSED');
  });
});
