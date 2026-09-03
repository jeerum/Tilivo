import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { withTenantTransaction } from '../src/services/tenantService';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.10 purchase receipts', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-v10-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: storageDir,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
      OCR_DRIVER: 'mock',
    });
    app = await buildApp({ config, db: pool });
    fixture = new SalesFixture(app, pool, 'v10');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setupTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    const expense = await fixture.createAccount(auth, '5000', 'Expense', 'EXPENSE');
    const ap = await fixture.createAccount(auth, '2400', 'AP', 'LIABILITY');
    const inputVat = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    const cash = await fixture.createAccount(auth, '1010', 'Cash', 'ASSET');
    const card = await fixture.createAccount(auth, '1020', 'Company card clearing', 'LIABILITY');
    const employee = await fixture.createAccount(auth, '2500', 'Employee payable', 'LIABILITY');
    const rcIn = await fixture.createAccount(auth, '1711', 'RC input', 'ASSET');
    const rcOut = await fixture.createAccount(auth, '2935', 'RC output', 'LIABILITY');
    const patch = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: ap,
        default_expense_account_id: expense,
        input_vat_account_id: inputVat,
        cash_account_id: cash,
        company_card_account_id: card,
        employee_payable_account_id: employee,
        reverse_charge_input_account_id: rcIn,
        reverse_charge_output_account_id: rcOut,
        auto_post_on_approval: false,
        require_separate_approver: false,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(patch, 200, 'settings');
    return { auth, accounts, expense, ap, inputVat, cash, card, employee };
  }

  async function codeId(auth: any, codeName: string): Promise<string> {
    const list = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=PURCHASE',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(list, 200, 'tax codes');
    const row = (list.body.tax_codes as Array<{ id: string; code: string }>).find((item) => item.code === codeName);
    if (!row) throw new Error(`missing tax code ${codeName}`);
    return String(row.id);
  }

  async function supplier(auth: any, businessId = 'FI12345678', name = 'Receipt Supplier Oy'): Promise<string> {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: {
        name,
        business_id: businessId,
        vat_id: businessId,
        country_code: 'FI',
        default_currency: 'EUR',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'supplier');
    return String(result.body.supplier.id);
  }

  async function createReceipt(
    auth: any,
    options: {
      supplierId?: string;
      merchant?: string;
      paymentMethod?: string;
      documentType?: string;
      total?: string;
    },
  ) {
    const taxCode = await codeId(auth, 'FI_PURCHASE_STD');
    const line: Record<string, unknown> = {
      description: 'Receipt line',
      quantity: '1',
      unit_price: options.total ?? '100.00',
      tax_code_id: taxCode,
    };
    const body: Record<string, unknown> = {
      invoice_date: '2026-09-10',
      due_date: '2026-09-10',
      currency_code: 'EUR',
      document_type: options.documentType ?? 'RECEIPT',
      payment_method: options.paymentMethod ?? 'CASH',
      payment_status: options.paymentMethod === 'BANK_TRANSFER' ? 'UNPAID' : 'PAID_AT_PURCHASE',
      lines: [line],
    };
    if (options.supplierId) body.supplier_id = options.supplierId;
    else body.merchant_name = options.merchant ?? 'Merchant X Oy';
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create receipt');
    return result.body.purchase as any;
  }

  async function upload(auth: any, purchaseId: string, filename: string, mime = 'image/jpeg'): Promise<void> {
    const usedMime = 'application/pdf';
    const body = Buffer.concat([
      Buffer.from(
        `--b\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${usedMime}\r\n\r\n`,
        'latin1',
      ),
      Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1'),
      Buffer.from('\r\n--b--\r\n', 'latin1'),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/purchases/${purchaseId}/documents`,
      headers: {
        'content-type': 'multipart/form-data; boundary=b',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'x-tilivo-tenant-id': auth.tenantId,
      },
      payload: body,
    });
    void mime;
    if (response.statusCode !== 201) {
      throw new Error(`upload ${filename} failed: ${response.statusCode} ${String(response.body ?? '')}`);
    }
  }

  async function ocr(auth: any, purchaseId: string): Promise<any> {
    const result = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${purchaseId}/ocr`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    return result;
  }

  async function transition(auth: any, purchaseId: string, action: string): Promise<any> {
    const result = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${purchaseId}/${action}`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    return result;
  }

  async function extractions(auth: any, purchaseId: string): Promise<any[]> {
    return withTenantTransaction(pool, auth.tenantId, async (client) => {
      const result = await client.query(
        `SELECT field_name, value, confidence FROM purchase_invoice_extractions
         WHERE purchase_invoice_id = $1 ORDER BY field_name`,
        [purchaseId],
      );
      return result.rows;
    });
  }

  it('uploads and OCRs a receipt, preserving the document on OCR failure', async () => {
    const { auth } = await setupTenant('V10 Ocr Oy');
    const receipt = await createReceipt(auth, { merchant: 'Mock Merchant Oy' });
    await upload(auth, receipt.id, 'receipt-fi.jpg');
    const result = await ocr(auth, receipt.id);
    expectStatus(result, 200, 'ocr');
    expect(String(result.body.purchase.ocr_status)).toBe('COMPLETE');
    expect(String(result.body.purchase.total)).toBe('125.50');
    const fields = await extractions(auth, receipt.id);
    expect(fields.some((row) => row.field_name === 'supplier_name' && row.value === 'Mock Merchant Oy')).toBe(true);
    expect(fields.some((row) => row.field_name === 'total' && row.value === '125.50')).toBe(true);

    const failing = await createReceipt(auth, { merchant: 'Malformed Oy' });
    await upload(auth, failing.id, 'malformed-receipt.jpg');
    const failedOcr = await ocr(auth, failing.id);
    expect(failedOcr.status).toBe(422);
    const after = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${failing.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(after.body.purchase.ocr_status)).toBe('FAILED');
    const docList = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${failing.id}/documents`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(docList.body.documents).toHaveLength(1);
  });

  it('matches an existing supplier by Business ID from OCR and leaves ambiguity unlinked', async () => {
    const { auth } = await setupTenant('V10 Match Oy');
    const supplierId = await supplier(auth, 'FI12345678');
    const receipt = await createReceipt(auth, { merchant: 'Unknown' });
    await upload(auth, receipt.id, 'receipt-fi.jpg');
    await ocr(auth, receipt.id);
    const matched = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${receipt.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(matched.body.purchase.supplier_id)).toBe(supplierId);
    expect(matched.body.purchase.supplier_snapshot.matched_from_ocr).toBe(true);

    const ambiguousA = await supplier(auth, 'FI11111111', 'Mock Supplier Oy');
    const ambiguousB = await supplier(auth, 'FI22222222', 'Mock Supplier Oy');
    const unknown = await createReceipt(auth, { merchant: 'Unknown' });
    await upload(auth, unknown.id, 'invoice-fi.jpg');
    await ocr(auth, unknown.id);
    const after = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${unknown.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(after.body.purchase.supplier_id).not.toBe(ambiguousA);
    expect(after.body.purchase.supplier_id).not.toBe(ambiguousB);
    void ambiguousA;
    void ambiguousB;
  });

  it('posts cash, company-card and employee-paid receipts to the right counter-accounts', async () => {
    const { auth } = await setupTenant('V10 Payments Oy');
    const scenarios = [
      { method: 'CASH', account: '1010' },
      { method: 'COMPANY_CARD', account: '1020' },
      { method: 'EMPLOYEE_PAID', account: '2500' },
    ];
    for (const scenario of scenarios) {
      const receipt = await createReceipt(auth, { merchant: `Merchant ${scenario.method}`, paymentMethod: scenario.method });
      for (const action of ['review', 'approve', 'post'] as const) {
        const result = await transition(auth, receipt.id, action);
        expectStatus(result, 200, `${scenario.method} ${action}`);
      }
      const detail = await fixture.request({
        method: 'GET',
        url: `/api/v1/purchases/${receipt.id}`,
        cookie: auth.cookie,
        tenantId: auth.tenantId,
      });
      const journal = await fixture.request({
        method: 'GET',
        url: `/api/v1/journals/${detail.body.purchase.accounting_journal_entry_id}`,
        cookie: auth.cookie,
        tenantId: auth.tenantId,
      });
      const lines = journal.body.journal.lines as Array<{ account_code: string; credit: string; debit: string }>;
      const counter = lines.find((line) => line.account_code === scenario.account);
      expect(Number(counter?.credit ?? counter?.debit ?? 0)).toBe(125.5);
      expect(String(detail.body.purchase.payment_status)).toBe('PAID_AT_PURCHASE');
    }
  });

  it('supports multi-rate OCR receipts with two VAT lines', async () => {
    const { auth } = await setupTenant('V10 Multi Oy');
    const receipt = await createReceipt(auth, { merchant: 'Multi Oy' });
    await upload(auth, receipt.id, 'multi-receipt.png', 'image/png');
    const result = await ocr(auth, receipt.id);
    expectStatus(result, 200, 'ocr multi');
    const ex = await extractions(auth, receipt.id);
    const supplierExtraction = ex.find((row) => row.field_name === 'supplier_name');
    expect(String(supplierExtraction?.value)).toBe('Mock Multi Cafe Oy');
    expect(String(result.body.purchase.total)).toBe('119.50');
    expect(result.body.purchase.lines).toHaveLength(2);
    const rates = (result.body.purchase.lines as Array<{ tax_rate_snapshot: string }>).map((line) => line.tax_rate_snapshot);
    expect(rates).toContain('25.5000');
    expect(rates).toContain('13.5000');
  });

  it('warns on heuristic duplicates and exact file-hash duplicates', async () => {
    const { auth } = await setupTenant('V10 Dup Oy');
    const first = await createReceipt(auth, { merchant: 'Dup Merchant', total: '100.00' });
    const second = await createReceipt(auth, { merchant: 'Dup Merchant', total: '100.00' });
    expect(String(second.duplicate_warning ?? '')).toContain('Possible duplicate');
    void first;

    const hashA = await createReceipt(auth, { merchant: 'Hash Merchant' });
    await upload(auth, hashA.id, 'receipt-fi.jpg');
    await ocr(auth, hashA.id);
    const hashB = await createReceipt(auth, { merchant: 'Hash Merchant' });
    await upload(auth, hashB.id, 'receipt-fi.jpg');
    const warning = await ocr(auth, hashB.id);
    expect(warning.body.purchase.duplicate_warning).toContain('identical source file');
  });

  it('keeps receipt posting immutable, period-locked and idempotent with audit events', async () => {
    const { auth, accounts } = await setupTenant('V10 Govern Oy');
    const receipt = await createReceipt(auth, { merchant: 'Govern Merchant' });
    for (const action of ['review', 'approve', 'post'] as const) {
      await expectStatus(await transition(auth, receipt.id, action), 200, action);
    }
    const doublePost = await transition(auth, receipt.id, 'post');
    expect(doublePost.status).toBe(409);

    const locked = await createReceipt(auth, { merchant: 'Locked Merchant' });
    await expectStatus(await transition(auth, locked.id, 'review'), 200, 'review locked');
    await expectStatus(await transition(auth, locked.id, 'approve'), 200, 'approve locked');
    const close = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${accounts.periodId}`,
      body: { status: 'CLOSED' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(close, 200, 'close period');
    const blocked = await transition(auth, locked.id, 'post');
    expect(blocked.status).toBe(409);
    expect(['PERIOD-002', 'PERIOD-003']).toContain(blocked.body.error.code);

    const audit = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS count FROM audit_events
         WHERE tenant_id = $1 AND action LIKE 'PURCHASE.%'`,
        [auth.tenantId],
      );
      return Number(result.rows[0].count);
    });
    expect(audit).toBeGreaterThan(0);
  });
});
