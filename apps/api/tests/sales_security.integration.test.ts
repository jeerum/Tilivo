import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { LocalObjectStorageProvider } from '../src/services/documentStorage';
import { processPdfRequest } from '../src/services/invoicePdfWorker';
import { withTenantTransaction } from '../src/services/tenantService';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.6 sales security and RLS', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storage: LocalObjectStorageProvider;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-sec-pdf-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: storageDir,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
    fixture = new SalesFixture(app, pool, 'salessec');
    workerPool = createPool(process.env.WORKER_TEST_DATABASE_URL!);
    storage = new LocalObjectStorageProvider(storageDir);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function accountingTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    return { auth, accounts };
  }

  async function addMemberWithRole(auth: any, roleName: string, ip = '10.0.60.1') {
    const user = await fixture.registerUser(ip);
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email: user.email, role_name: roleName },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip,
    });
    expectStatus(result, 201, `add ${roleName} member`);
    const login = await fixture.request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: user.email, password: 'correct horse battery staple' },
      ip,
    });
    expectStatus(login, 200, `${roleName} login`);
    return {
      cookie: login.cookie,
      csrf: login.body.csrf_token as string,
      tenantId: auth.tenantId,
    };
  }

  it('isolates customers, invoices and PDFs between tenants', async () => {
    const tenantA = await accountingTenant('Sales Security A Oy');
    const tenantB = await accountingTenant('Sales Security B Oy');
    const customerId = await fixture.createCustomer(tenantA.auth, 'Tenant A Customer');
    const draft = await fixture.createDraft(
      tenantA.auth,
      customerId,
      [
        {
          description: 'Private line',
          quantity: '1',
          unit_price: '100',
          tax_code_id: tenantA.accounts.taxStandardId,
        },
      ],
    );
    const issued = await fixture.issueInvoice(tenantA.auth, draft.id);

    // Cross-tenant reads and writes fail with not found (no existence leak).
    const readCustomer = await fixture.request({
      method: 'GET',
      url: `/api/v1/customers/${customerId}`,
      cookie: tenantB.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(readCustomer, 404, 'cross-tenant customer read');
    const readInvoice = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}`,
      cookie: tenantB.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(readInvoice, 404, 'cross-tenant invoice read');
    const issue = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/issue`,
      cookie: tenantB.auth.cookie,
      csrf: tenantB.auth.csrf,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(issue, 404, 'cross-tenant issue');
    const pdf = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}/pdf`,
      cookie: tenantB.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expect([404, 409]).toContain(pdf.status);

    // Direct DB without tenant context sees no sales data.
    const noContext = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM business_parties) AS parties,
         (SELECT count(*)::int FROM sales_invoices) AS invoices`,
    );
    expect(noContext.rows[0]!.parties).toBe(0);
    expect(noContext.rows[0]!.invoices).toBe(0);

    // Tenant B runtime role cannot see A's rows even with the invoice id.
    await withTenantTransaction(pool, tenantB.auth.tenantId, async (client) => {
      const hidden = await client.query(
        'SELECT count(*)::int AS count FROM sales_invoices WHERE id = $1',
        [draft.id],
      );
      expect(hidden.rows[0]!.count).toBe(0);
    });

    // A remains able to generate its own PDF.
    const outbox = await workerPool.query(
      `SELECT id, tenant_id, aggregate_id, event_type FROM integration_outbox
       WHERE tenant_id = $1 AND event_type = 'SALES_INVOICE_PDF_REQUESTED' AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantA.auth.tenantId],
    );
    if (outbox.rows[0]) {
      await processPdfRequest(workerPool, storage, {
        id: String(outbox.rows[0].id),
        tenant_id: String(outbox.rows[0].tenant_id),
        aggregate_id: String(outbox.rows[0].aggregate_id),
        aggregate_type: 'sales_invoice',
        event_type: String(outbox.rows[0].event_type),
        payload: '{}',
        attempt_count: 0,
      });
    }
    const ownPdf = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}/pdf`,
      cookie: tenantA.auth.cookie,
      tenantId: tenantA.auth.tenantId,
    });
    expectStatus(ownPdf, 200, 'own tenant pdf');
    void issued;
  });

  it('enforces built-in sales permissions for Viewer and Accountant roles', async () => {
    const { auth, accounts } = await accountingTenant('Sales Permissions Oy');
    const viewer = await addMemberWithRole(auth, 'Viewer', '10.0.60.2');
    const read = await fixture.request({
      method: 'GET',
      url: '/api/v1/customers',
      cookie: viewer.cookie,
      tenantId: viewer.tenantId,
    });
    expectStatus(read, 200, 'viewer sales read');
    const createCustomer = await fixture.request({
      method: 'POST',
      url: '/api/v1/customers',
      body: { name: 'Should Fail' },
      cookie: viewer.cookie,
      csrf: viewer.csrf,
      tenantId: viewer.tenantId,
    });
    expectStatus(createCustomer, 403, 'viewer cannot manage customers');
    const createInvoice = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/invoices',
      body: { customer_id: '', lines: [] },
      cookie: viewer.cookie,
      csrf: viewer.csrf,
      tenantId: viewer.tenantId,
    });
    expectStatus(createInvoice, 403, 'viewer cannot create invoices');

    const accountant = await addMemberWithRole(auth, 'Accountant', '10.0.60.3');
    const customerId = await fixture.createCustomer(
      { ...accountant, userId: auth.userId } as any,
      'Accountant Customer',
    );
    const draft = await fixture.createDraft(
      accountant as any,
      customerId,
      [{ description: 'Managed by accountant', quantity: '1', unit_price: '80', tax_code_id: accounts.taxStandardId }],
    );
    const issue = await fixture.issueInvoice(accountant as any, draft.id);
    expect(issue.invoice.status).toBe('ISSUED');

    const settingsPatch = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/sales/settings',
      body: { default_language: 'fi' },
      cookie: accountant.cookie,
      csrf: accountant.csrf,
      tenantId: accountant.tenantId,
    });
    expectStatus(settingsPatch, 403, 'accountant cannot manage sales settings');
  });

  it('denies issued invoice and line mutations at the DB level for the runtime role', async () => {
    const { auth, accounts } = await accountingTenant('Sales Direct DB Oy');
    const customerId = await fixture.createCustomer(auth);
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        {
          description: 'Immutable line',
          quantity: '1',
          unit_price: '500',
          tax_code_id: accounts.taxStandardId,
        },
      ],
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoiceId = String(issued.invoice.id);
    const lineResult = await withTenantTransaction(pool, auth.tenantId, (client) =>
      client.query(
      'SELECT id FROM sales_invoice_lines WHERE sales_invoice_id = $1 AND tenant_id = $2',
      [invoiceId, auth.tenantId],
      ),
    );
    const lineId = String(lineResult.rows[0]!.id);

    const attempts: Array<() => Promise<unknown>> = [
      () =>
        withTenantTransaction(pool, auth.tenantId, (client) =>
          client.query(`UPDATE sales_invoices SET total = '1.00' WHERE id = $1 AND tenant_id = $2`, [
            invoiceId,
            auth.tenantId,
          ]),
        ),
      () =>
        withTenantTransaction(pool, auth.tenantId, (client) =>
          client.query(`UPDATE sales_invoices SET invoice_number = 'hacked' WHERE id = $1`, [invoiceId]),
        ),
      () =>
        withTenantTransaction(pool, auth.tenantId, (client) =>
          client.query(`DELETE FROM sales_invoices WHERE id = $1 AND tenant_id = $2`, [
            invoiceId,
            auth.tenantId,
          ]),
        ),
      () =>
        withTenantTransaction(pool, auth.tenantId, (client) =>
          client.query(`UPDATE sales_invoice_lines SET net_amount = '0.01' WHERE id = $1`, [lineId]),
        ),
      () =>
        withTenantTransaction(pool, auth.tenantId, (client) =>
          client.query(`DELETE FROM sales_invoice_lines WHERE id = $1`, [lineId]),
        ),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow();
    }

    // Credit link rows are insert-only and tamper-proof.
    const credit = await fixture.creditInvoice(auth, invoiceId, 'direct DB tamper guard');
    const link = await withTenantTransaction(pool, auth.tenantId, (client) =>
      client.query(
      `SELECT id FROM sales_invoice_credit_links WHERE original_invoice_id = $1 AND tenant_id = $2`,
      [invoiceId, auth.tenantId],
      ),
    );
    const linkId = String(link.rows[0]!.id);
    await expect(
      withTenantTransaction(pool, auth.tenantId, (client) =>
        client.query(`UPDATE sales_invoice_credit_links SET reason = 'tampered' WHERE id = $1`, [linkId]),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(pool, auth.tenantId, (client) =>
        client.query(`DELETE FROM sales_invoice_credit_links WHERE id = $1`, [linkId]),
      ),
    ).rejects.toThrow();
    void credit;
  });

  it('fails closed without a tenant header and rejects tenant spoofing', async () => {
    const tenantA = await accountingTenant('Sales Spoof A Oy');
    const tenantB = await accountingTenant('Sales Spoof B Oy');
    const noHeader = await fixture.request({
      method: 'GET',
      url: '/api/v1/customers',
      cookie: tenantA.auth.cookie,
    });
    expectStatus(noHeader, 400, 'tenant header required');
    const spoof = await fixture.request({
      method: 'GET',
      url: '/api/v1/customers',
      cookie: tenantA.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(spoof, 404, 'tenant spoof denied');
  });
});
