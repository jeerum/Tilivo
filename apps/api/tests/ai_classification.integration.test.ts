import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { SalesFixture, expectStatus } from './salesTestSupport';
import { withTenantTransaction } from '../src/services/tenantService';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.11 AI classification integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-v11-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: storageDir,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
      EXPENSE_AI_DRIVER: 'mock',
    });
    app = await buildApp({ config, db: pool });
    fixture = new SalesFixture(app, pool, 'ai11');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setupTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const expense = await fixture.createAccount(auth, '5001', 'Office supplies', 'EXPENSE');
    const materials = await fixture.createAccount(auth, '5000', 'Materials', 'EXPENSE');
    const software = await fixture.createAccount(auth, '5100', 'Software subscriptions', 'EXPENSE');
    const vehicle = await fixture.createAccount(auth, '5200', 'Vehicle expenses', 'EXPENSE');
    const inputVat = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    const settings = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: expense,
        default_expense_account_id: expense,
        input_vat_account_id: inputVat,
        cash_account_id: expense,
        company_card_account_id: expense,
        employee_payable_account_id: expense,
        auto_post_on_approval: false,
        require_separate_approver: false,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(settings, 200, 'settings');
    return { auth, expense, materials, software, vehicle };
  }

  async function codeId(auth: any): Promise<string> {
    const list = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=PURCHASE',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const row = (list.body.tax_codes as Array<{ id: string; code: string }>).find((item) => item.code === 'FI_PURCHASE_STD');
    if (!row) throw new Error('missing tax code');
    return String(row.id);
  }

  async function receipt(auth: any, merchant: string, description: string) {
    const taxCode = await codeId(auth);
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        merchant_name: merchant,
        invoice_date: '2026-09-10',
        document_type: 'RECEIPT',
        payment_method: 'COMPANY_CARD',
        payment_status: 'PAID_AT_PURCHASE',
        description,
        lines: [{ description, quantity: '1', unit_price: '125.50', tax_code_id: taxCode }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'receipt');
    return result.body.purchase as any;
  }

  it('classifies, persists, caches by fingerprint and applies fields', async () => {
    const { auth, expense } = await setupTenant('AI Office Oy');
    const doc = await receipt(auth, 'Office Merchant Oy', 'Office supplies');
    const first = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${doc.id}/classification`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(first, 200, 'classify');
    const run = first.body.classification;
    expect(run.status).toBe('READY');
    expect(run.suggestions.category).toBe('office');
    expect(run.suggestions.expenseAccountId).toBe(expense);

    const again = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${doc.id}/classification`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(again.body.classification.id).toBe(run.id);

    const apply = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${doc.id}/classification/apply`,
      body: { expense_account_id: expense },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(apply, 200, 'apply');
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${doc.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(detail.body.purchase.lines[0].expense_account_id)).toBe(expense);
  });

  it('classifies software and fuel into correct categories with confidence', async () => {
    const { auth } = await setupTenant('AI Categories Oy');
    const software = await receipt(auth, 'SaaS Oy', 'Software subscription');
    const sw = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${software.id}/classification`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(sw.body.classification.suggestions.category).toBe('software');
    const fuel = await receipt(auth, 'St1', 'Fuel');
    const fuelRun = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${fuel.id}/classification`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(fuelRun.body.classification.suggestions.category).toBe('vehicle');
    expect(fuelRun.body.classification.suggestions.overallConfidence).toBeLessThan(0.9);
  });

  it('rejects invalid cross-tenant account IDs and provider failures leave documents usable', async () => {
    const { auth } = await setupTenant('AI Security Oy');
    const foreign = await setupTenant('AI Foreign Oy');
    const doc = await receipt(auth, 'Office Merchant Oy', 'Office supplies');
    const badApply = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${doc.id}/classification/apply`,
      body: { expense_account_id: foreign.expense },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(badApply.status).toBe(400);

    const failing = await receipt(auth, 'Malformed Merchant Oy', 'malformed classification');
    const failed = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${failing.id}/classification`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(failed.status).toBe(422);
    const stillUsable = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${failing.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(stillUsable, 200, 'document remains usable');
    void foreign;
  });

  it('requires apply permission for Employee classification role matrix', async () => {
    const { auth } = await setupTenant('AI Permissions Oy');
    const employee = await fixture.registerUser();
    await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const membership = await client.query(
        `INSERT INTO memberships (tenant_id, user_id, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
        [auth.tenantId, employee.userId],
      );
      const role = await client.query(`SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Employee'`, [auth.tenantId]);
      await client.query(`INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1,$2,$3)`, [
        auth.tenantId,
        membership.rows[0].id,
        role.rows[0].id,
      ]);
    });
    const doc = await receipt(auth, 'Office Merchant Oy', 'Office supplies');
    const denied = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${doc.id}/classification/apply`,
      cookie: employee.cookie,
      csrf: employee.csrf,
      tenantId: auth.tenantId,
    });
    expect(denied.status).toBe(403);
  });
});
