import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.12 sales ledger', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-ledger-v12-'));
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
    fixture = new SalesFixture(app, pool, 'ledger12');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setup(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const customerId = await fixture.createCustomer(auth);
    return { auth, customerId, accounts };
  }

  it('records partial and full payments and maintains payment status', async () => {
    const { auth, customerId, accounts } = await setup('Ledger Payments Oy');
    const taxList = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=SALES',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const std = (taxList.body.tax_codes as Array<{ id: string; code: string }>).find((row) => row.code === 'FI_SALES_STD');
    const draft = await fixture.createDraft(auth, customerId, [
      { description: 'Ledger item', quantity: '1', unit_price: '1000.00', tax_code_id: String(std!.id) },
    ]);
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoiceId = String(issued.invoice.id);

    const partial = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/payments`,
      body: { amount: '400.00', payment_date: '2026-09-15', method: 'MANUAL', note: 'partial' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(partial, 200, 'partial payment');
    expect(partial.body.payment_status).toBe('PARTIALLY_PAID');
    const full = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/payments`,
      body: { amount: '855.00', payment_date: '2026-09-20' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(full, 200, 'full payment');
    expect(full.body.payment_status).toBe('PAID');

    const ledger = await fixture.request({
      method: 'GET',
      url: '/api/v1/sales/ledger',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(ledger.body.invoices.length).toBeGreaterThan(0);
    void accounts;
  });

  it('creates reminders with history and protects tenant isolation', async () => {
    const { auth, customerId } = await setup('Ledger Reminders Oy');
    const taxList = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=SALES',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const std = (taxList.body.tax_codes as Array<{ id: string; code: string }>).find((row) => row.code === 'FI_SALES_STD');
    const draft = await fixture.createDraft(auth, customerId, [
      { description: 'Overdue item', quantity: '1', unit_price: '200.00', tax_code_id: String(std!.id) },
    ]);
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoiceId = String(issued.invoice.id);
    const reminder = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/reminders`,
      body: { note: 'First reminder' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reminder, 200, 'reminder');
    const list = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${invoiceId}/reminders`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(list.body.reminders).toHaveLength(1);

    const other = await fixture.registerUser();
    const otherTenant = await fixture.createTenant(other.cookie, other.csrf, 'Ledger Other Oy');
    const forbidden = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/payments`,
      body: { amount: '10.00', payment_date: '2026-09-15' },
      cookie: other.cookie,
      csrf: other.csrf,
      tenantId: otherTenant.tenantId,
    });
    expect(forbidden.status).toBe(404);
  });

  it('recurring template generates exactly one draft per period', async () => {
    const { auth, customerId, accounts } = await setup('Ledger Recurring Oy');
    const taxList = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=SALES',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const std = (taxList.body.tax_codes as Array<{ id: string; code: string }>).find((row) => row.code === 'FI_SALES_STD');
    const template = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/recurring-templates',
      body: {
        customer_id: customerId,
        name: 'Monthly fee',
        frequency: 'MONTHLY',
        start_date: '2026-09-01',
        payment_terms_days: 14,
        language: 'fi',
        lines: [{ description: 'Monthly service', quantity: '1', unit_price: '50.00', tax_code_id: String(std!.id) }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(template, 201, 'template');
    const first = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/recurring-templates/generate',
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    if (first.status !== 200) throw new Error(`generate failed ${JSON.stringify(first.body)}`);
    expect(first.body.generated).toHaveLength(1);
    const second = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/recurring-templates/generate',
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(second.body.generated).toHaveLength(0);
    void accounts;
  });
});
