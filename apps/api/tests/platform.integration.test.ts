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
import { verifyAuditChain } from '../src/services/auditQuery';
import { withTenantTransaction } from '../src/services/tenantService';
import { writeAuditEvent } from '../src/services/audit';

const databaseUrl = process.env.TEST_DATABASE_URL;
const workerDatabaseUrl = process.env.WORKER_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl || !workerDatabaseUrl)('v0.4 platform integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let ownerPool: ReturnType<typeof createPool> | null = null;
  let emailCounter = 0;

  function nextEmail(): string {
    emailCounter += 1;
    return `platform${emailCounter}@example.com`;
  }

  async function registerLogin(ip: string): Promise<{ cookie: string; csrf: string; email: string }> {
    const email = nextEmail();
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: { email, password: 'correct horse battery staple' },
    });
    expect(register.statusCode).toBe(202);
    const mail = await pool.query(
      'SELECT body FROM dev_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const token = String(mail.rows[0]!.body).match(/token=([^&\s]+)/)![1]!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: { token: decodeURIComponent(token) },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: { email, password: 'correct horse battery staple' },
    });
    const cookie = (login.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
    return { cookie, csrf: login.json().csrf_token as string, email };
  }

  async function createTenant(
    auth: { cookie: string; csrf: string },
    name: string,
  ): Promise<string> {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'x-forwarded-for': '10.0.20.10',
      },
      payload: { name, company: { legal_name: name } },
    });
    expect(result.statusCode).toBe(201);
    return result.json().tenant.id as string;
  }

  function pdfBody(filename: string, prefix = '%PDF-1.4 test'): Buffer {
    const boundary = '----tilivo';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return Buffer.concat([head, Buffer.from(prefix), tail]);
  }

  async function uploadPdf(
    auth: { cookie: string; csrf: string },
    tenantId: string,
    filename = 'test.pdf',
    prefix = '%PDF-1.4 test',
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: {
        'content-type': 'multipart/form-data; boundary=----tilivo',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'x-tilivo-tenant-id': tenantId,
      },
      payload: pdfBody(filename, prefix),
    });
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    workerPool = createPool(workerDatabaseUrl!);
    if (process.env.MIGRATION_DATABASE_URL) ownerPool = createPool(process.env.MIGRATION_DATABASE_URL);
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
    await ownerPool?.end();
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

  it('audit hash chain detects tampering', async () => {
    if (!ownerPool) return;
    const before = await verifyAuditChain(ownerPool);
    expect(before.valid).toBe(true);
    const target = await ownerPool.query(
      'SELECT id FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    if (!target.rows[0]) return;
    await ownerPool.query(`UPDATE audit_events SET metadata = '{"tampered":true}' WHERE id = $1`, [
      target.rows[0].id,
    ]);
    const after = await verifyAuditChain(ownerPool);
    expect(after.valid).toBe(false);
    expect(after.brokenAt).toBeTruthy();
  });

  it('audit hash chain stays valid under parallel writes', async () => {
    const request = {
      ip: '10.0.99.10',
      id: 'parallel-audit-trace',
      headers: { 'user-agent': 'parallel-audit-test' },
    } as any;
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writeAuditEvent(pool, 'AUTH.LOGIN_FAILED', request, {
          metadata: { attempt: index },
        }),
      ),
    );
    const check = await verifyAuditChain(ownerPool ?? pool);
    expect(check.valid).toBe(true);
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

  it('document hostile matrix: cross-tenant, signatures, traversal, immutability', async () => {
    const ownerA = await registerLogin('10.0.20.20');
    const ownerB = await registerLogin('10.0.20.21');
    const tenantA = await createTenant(ownerA, 'Doc Tenant A');
    const tenantB = await createTenant(ownerB, 'Doc Tenant B');

    const upload = await uploadPdf(ownerA, tenantA, '../../evil.pdf');
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json().document.id as string;
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/documents',
      headers: { cookie: ownerA.cookie, 'x-tilivo-tenant-id': tenantA },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().documents[0].original_filename).not.toContain('/');

    const crossRead = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/download`,
      headers: { cookie: ownerB.cookie, 'x-tilivo-tenant-id': tenantB },
    });
    expect(crossRead.statusCode).toBe(404);

    const crossConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/confirm`,
      headers: { cookie: ownerB.cookie, 'x-csrf-token': ownerB.csrf, 'x-tilivo-tenant-id': tenantB },
    });
    expect(crossConfirm.statusCode).toBe(404);

    const badSignature = await uploadPdf(ownerA, tenantA, 'fake.pdf', 'not a pdf at all');
    expect(badSignature.statusCode).toBe(415);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: {
        'content-type': 'multipart/form-data; boundary=----tilivo',
        cookie: ownerA.cookie,
        'x-csrf-token': ownerA.csrf,
        'x-tilivo-tenant-id': tenantA,
      },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/confirm`,
      headers: { cookie: ownerA.cookie, 'x-csrf-token': ownerA.csrf, 'x-tilivo-tenant-id': tenantA },
    });
    expect(confirm.statusCode).toBe(200);

    await expect(
      withTenantTransaction(pool, tenantA, async (client) => {
        await client.query(
          `UPDATE document_versions SET original_filename = 'tampered' WHERE document_id = $1`,
          [documentId],
        );
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('immutable') });
  });
});
