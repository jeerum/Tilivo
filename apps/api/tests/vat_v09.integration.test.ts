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

describe.skipIf(!databaseUrl)('v0.9 VAT engine integration', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-v09-'));
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
    fixture = new SalesFixture(app, pool, 'vat09');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setupTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    const expenseAccountId = await fixture.createAccount(auth, '5000', 'Purchases', 'EXPENSE');
    const apAccountId = await fixture.createAccount(auth, '2400', 'Accounts payable', 'LIABILITY');
    const inputVatAccountId = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    const rcInputAccountId = await fixture.createAccount(auth, '1711', 'RC input VAT', 'ASSET');
    const rcOutputAccountId = await fixture.createAccount(auth, '2935', 'RC output VAT', 'LIABILITY');
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const settings = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: apAccountId,
        default_expense_account_id: expenseAccountId,
        input_vat_account_id: inputVatAccountId,
        reverse_charge_input_account_id: rcInputAccountId,
        reverse_charge_output_account_id: rcOutputAccountId,
        auto_post_on_approval: false,
        require_separate_approver: false,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(settings, 200, 'purchase settings');
    return { auth, accounts, expenseAccountId, apAccountId, inputVatAccountId, rcInputAccountId, rcOutputAccountId };
  }

  async function taxCodes(auth: any, direction?: string, current = true): Promise<any[]> {
    const url = `/api/v1/tax-codes?current=${current}${direction ? `&direction=${direction}` : ''}`;
    const result = await fixture.request({ method: 'GET', url, cookie: auth.cookie, tenantId: auth.tenantId });
    expectStatus(result, 200, `list tax codes ${url}`);
    return result.body.tax_codes as any[];
  }

  async function codeId(auth: any, direction: 'SALES' | 'PURCHASE', codeName: string): Promise<string> {
    const rows = await taxCodes(auth, direction, true);
    const match = rows.find((row) => row.code === codeName);
    if (!match) throw new Error(`Seeded code ${codeName} missing for ${direction}`);
    return String(match.id);
  }

  async function createCustomer(auth: any, country = 'FI', vatId = 'FI12345678'): Promise<string> {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/customers',
      body: {
        name: `Vat customer ${Math.random().toString(36).slice(2, 8)}`,
        country_code: country,
        vat_id: country === 'FI' ? vatId : (country === 'DE' ? `DE${vatId.slice(2)}` : vatId),
        default_currency: 'EUR',
        language: 'fi',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create customer');
    return String(result.body.customer.id);
  }

  async function createSupplier(auth: any, country = 'FI'): Promise<string> {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: {
        name: `Vat supplier ${Math.random().toString(36).slice(2, 8)}`,
        country_code: country,
        default_currency: 'EUR',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create supplier');
    return String(result.body.supplier.id);
  }

  async function sale(auth: any, customerId: string, taxCode: string, amount: string, date = '2026-09-10', qty = '1') {
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: `VAT line ${taxCode}`, quantity: qty, unit_price: amount, tax_code_id: taxCode }],
      { issue_date: date },
    );
    return fixture.issueInvoice(auth, draft.id);
  }

  async function createPurchase(
    auth: any,
    supplierId: string,
    taxCode: string,
    amount: string,
    expenseAccountId: string,
    deductible?: string,
  ) {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        supplier_id: supplierId,
        supplier_invoice_number: `P-${Math.random().toString(36).slice(2, 10)}`,
        invoice_date: '2026-09-10',
        due_date: '2026-10-10',
        lines: [
          {
            description: 'Purchase VAT line',
            quantity: '1',
            unit_price: amount,
            tax_code_id: taxCode,
            expense_account_id: expenseAccountId,
            ...(deductible ? { deductible_percent: deductible } : {}),
          },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create purchase draft');
    let purchase = result.body.purchase as any;
    for (const action of ['review', 'approve', 'post'] as const) {
      const transition = await fixture.request({
        method: 'POST',
        url: `/api/v1/purchases/${purchase.id}/${action}`,
        cookie: auth.cookie,
        csrf: auth.csrf,
        tenantId: auth.tenantId,
      });
      expectStatus(transition, 200, `purchase ${action}`);
      purchase = transition.body.purchase ?? purchase;
    }
    return purchase;
  }

  async function journal(auth: any, entryId: string): Promise<any> {
    const result = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${entryId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 200, 'journal detail');
    return result.body.journal;
  }

  async function addMember(auth: any, user: any, roleName: string): Promise<void> {
    await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const membership = await client.query(
        `INSERT INTO memberships (tenant_id, user_id, status)
         VALUES ($1, $2, 'ACTIVE') RETURNING id`,
        [auth.tenantId, user.userId],
      );
      const role = await client.query(
        `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
        [auth.tenantId, roleName],
      );
      await client.query(
        `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3)`,
        [auth.tenantId, membership.rows[0].id, role.rows[0].id],
      );
    });
  }

  it('seeds a Finnish default tax-code set with semantic metadata', async () => {
    const { auth } = await setupTenant('Vat Seed Oy');
    const all = await taxCodes(auth, undefined, false);
    const sales = await taxCodes(auth, 'SALES', true);
    const purchases = await taxCodes(auth, 'PURCHASE', true);
    expect(all.filter((row) => row.is_system).length).toBeGreaterThanOrEqual(22);
    const standardHistory = all.filter((row) => row.code === 'FI_SALES_STD');
    expect(standardHistory.some((row) => Number(row.rate) === 24 && row.effective_to === '2024-08-31')).toBe(true);
    expect(standardHistory.some((row) => Number(row.rate) === 25.5 && row.effective_to === null)).toBe(true);
    expect(sales.every((row) => ['SALES', 'BOTH'].includes(row.direction))).toBe(true);
    expect(purchases.some((row) => row.code === 'FI_CONSTRUCTION_RC_PURCHASE')).toBe(true);
    const std = sales.find((row) => row.code === 'FI_SALES_STD');
    expect(std?.treatment).toBe('STANDARD');
    expect(std?.is_system).toBe(true);
  });

  it('posts a standard domestic sale with VAT metadata on journal lines', async () => {
    const { auth } = await setupTenant('Vat Sale Oy');
    const customerId = await createCustomer(auth);
    const taxCode = await codeId(auth, 'SALES', 'FI_SALES_STD');
    const issued = await sale(auth, customerId, taxCode, '1000.00');
    expect(String(issued.invoice.tax_total)).toBe('255.00');
    expect(String(issued.invoice.total)).toBe('1255.00');
    const entry = await journal(auth, String(issued.journal_entry_id));
    const revenue = entry.lines.find((line: any) => line.tax_leg_type === 'REVENUE');
    const output = entry.lines.find((line: any) => line.tax_leg_type === 'OUTPUT_VAT');
    expect(revenue.tax_reporting_classification).toBe('DOMESTIC_OUTPUT_VAT');
    expect(revenue.tax_code_snapshot).toBe('FI_SALES_STD');
    expect(Number(output.tax_amount_snapshot)).toBe(255);
    expect(Number(output.taxable_base_snapshot)).toBe(1000);
    expect(Number(output.credit)).toBe(255);
    expect(output.tax_reporting_classification).toBe('DOMESTIC_OUTPUT_VAT');
  });

  it('supports multi-rate sales on one invoice (standard + reduced + zero)', async () => {
    const { auth } = await setupTenant('Vat Mixed Oy');
    const customerId = await createCustomer(auth);
    const standard = await codeId(auth, 'SALES', 'FI_SALES_STD');
    const reduced = await codeId(auth, 'SALES', 'FI_SALES_REDUCED_MAIN');
    const zero = await codeId(auth, 'SALES', 'FI_SALES_ZERO');
    const draft = await fixture.createDraft(auth, customerId, [
      { description: 'Standard', quantity: '1', unit_price: '200', tax_code_id: standard },
      { description: 'Reduced', quantity: '1', unit_price: '100', tax_code_id: reduced },
      { description: 'Zero', quantity: '1', unit_price: '50', tax_code_id: zero },
    ]);
    expect(String(draft.subtotal)).toBe('350.00');
    expect(String(draft.tax_total)).toBe('64.50');
    const issued = await fixture.issueInvoice(auth, draft.id);
    expect(String(issued.invoice.total)).toBe('414.50');
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${issued.invoice.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const lines = detail.body.invoice.lines as Array<Record<string, string>>;
    expect(lines.find((line) => Number(line.tax_rate_snapshot) === 25.5)?.tax_amount).toBe('51.00');
    expect(lines.find((line) => Number(line.tax_rate_snapshot) === 13.5)?.tax_amount).toBe('13.50');
    expect(lines.find((line) => line.tax_treatment_snapshot === 'ZERO_RATED')?.tax_amount).toBe('0.00');
  });

  it('posts a deductible domestic purchase with input VAT', async () => {
    const { auth, expenseAccountId } = await setupTenant('Vat Purchase Oy');
    const supplierId = await createSupplier(auth);
    const taxCode = await codeId(auth, 'PURCHASE', 'FI_PURCHASE_STD');
    const purchase = await createPurchase(auth, supplierId, taxCode, '1000.00', expenseAccountId);
    expect(String(purchase.total)).toBe('1255.00');
    const entry = await journal(auth, String(purchase.accounting_journal_entry_id));
    const expense = entry.lines.find((line: any) => line.tax_leg_type === 'EXPENSE');
    const input = entry.lines.find((line: any) => line.tax_leg_type === 'INPUT_VAT');
    expect(Number(expense.debit)).toBe(1000);
    expect(Number(input.debit)).toBe(255);
    expect(Number(input.tax_deductible_snapshot)).toBe(255);
    expect(input.tax_reporting_classification).toBe('DOMESTIC_INPUT_VAT');
    expect(Number(entry.lines.find((line: any) => line.account_code === '2400').credit)).toBe(1255);
  });

  it('posts partial purchase deductibility into expense and input VAT', async () => {
    const { auth, expenseAccountId } = await setupTenant('Vat Partial Oy');
    const supplierId = await createSupplier(auth);
    const taxCode = await codeId(auth, 'PURCHASE', 'FI_PURCHASE_STD');
    const purchase = await createPurchase(auth, supplierId, taxCode, '100.00', expenseAccountId, '50');
    const entry = await journal(auth, String(purchase.accounting_journal_entry_id));
    const expense = entry.lines.find((line: any) => line.tax_leg_type === 'EXPENSE');
    const input = entry.lines.find((line: any) => line.tax_leg_type === 'INPUT_VAT');
    expect(Number(expense.debit)).toBe(112.75);
    expect(Number(input.debit)).toBe(12.75);
    expect(Number(expense.tax_nondeductible_snapshot)).toBe(12.75);
  });

  it('self-assesses a reverse-charge purchase on both sides', async () => {
    const { auth, expenseAccountId } = await setupTenant('Vat RC Oy');
    const supplierId = await createSupplier(auth);
    const taxCode = await codeId(auth, 'PURCHASE', 'FI_RC_PURCHASE');
    const purchase = await createPurchase(auth, supplierId, taxCode, '1000.00', expenseAccountId);
    expect(String(purchase.total)).toBe('1000.00');
    expect(String(purchase.tax_total)).toBe('0.00');
    const entry = await journal(auth, String(purchase.accounting_journal_entry_id));
    const output = entry.lines.find((line: any) => line.tax_leg_type === 'RC_OUTPUT_VAT');
    const input = entry.lines.find((line: any) => line.tax_leg_type === 'RC_INPUT_VAT');
    const expense = entry.lines.find((line: any) => line.tax_leg_type === 'EXPENSE');
    expect(Number(output.credit)).toBe(255);
    expect(Number(input.debit)).toBe(255);
    expect(Number(expense.debit)).toBe(1000);
    expect(output.tax_reporting_classification).toBe('REVERSE_CHARGE');
  });

  it('issues a construction reverse-charge sale without output VAT and with legal wording', async () => {
    const { auth } = await setupTenant('Vat Construction Oy');
    const customerId = await createCustomer(auth);
    const taxCode = await codeId(auth, 'SALES', 'FI_CONSTRUCTION_RC_SALE');
    const issued = await sale(auth, customerId, taxCode, '1000.00');
    expect(String(issued.invoice.tax_total)).toBe('0.00');
    const entry = await journal(auth, String(issued.journal_entry_id));
    expect(entry.lines.some((line: any) => line.tax_leg_type === 'OUTPUT_VAT')).toBe(false);
    const revenue = entry.lines.find((line: any) => line.tax_leg_type === 'REVENUE');
    expect(revenue.tax_reporting_classification).toBe('CONSTRUCTION_RC');
    expect(Number(revenue.credit)).toBe(1000);
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${issued.invoice.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const line = (detail.body.invoice.lines as Array<Record<string, string>>)[0]!;
    expect(String(line.tax_legal_note)).toContain('8 c');
  });

  it('self-assesses EU goods and keeps EU services separate', async () => {
    const { auth, expenseAccountId } = await setupTenant('Vat EU Oy');
    const euSupplier = await createSupplier(auth, 'DE');
    const euPurchase = await codeId(auth, 'PURCHASE', 'FI_EU_GOODS_PURCHASE');
    const purchase = await createPurchase(auth, euSupplier, euPurchase, '1000.00', expenseAccountId);
    const entry = await journal(auth, String(purchase.accounting_journal_entry_id));
    expect(entry.lines.some((line: any) => line.tax_reporting_classification === 'EU_GOODS_ACQUISITION')).toBe(true);
    expect(entry.lines.some((line: any) => line.tax_leg_type === 'RC_OUTPUT_VAT')).toBe(true);
    expect(entry.lines.some((line: any) => line.tax_leg_type === 'RC_INPUT_VAT')).toBe(true);

    const euCustomer = await createCustomer(auth, 'DE', 'DE123456789');
    const serviceSale = await codeId(auth, 'SALES', 'FI_EU_SERVICE_SALE');
    const issued = await sale(auth, euCustomer, serviceSale, '500.00');
    const saleEntry = await journal(auth, String(issued.journal_entry_id));
    const revenue = saleEntry.lines.find((line: any) => line.tax_leg_type === 'REVENUE');
    expect(revenue.tax_reporting_classification).toBe('EU_SERVICES_SUPPLY');
    expect(Number(revenue.credit)).toBe(500);
  });

  it('posts exports outside the EU as zero-tax sales with export classification', async () => {
    const { auth } = await setupTenant('Vat Export Oy');
    const usCustomer = await createCustomer(auth, 'US', '');
    const taxCode = await codeId(auth, 'SALES', 'FI_EXPORT');
    const issued = await sale(auth, usCustomer, taxCode, '800.00');
    expect(String(issued.invoice.total)).toBe('800.00');
    const entry = await journal(auth, String(issued.journal_entry_id));
    const revenue = entry.lines.find((line: any) => line.tax_leg_type === 'REVENUE');
    expect(revenue.tax_reporting_classification).toBe('EXPORT');
  });

  it('keeps historical tax rates stable across dates', async () => {
    const { auth } = await setupTenant('Vat History Oy');
    const fy2024 = await fixture.createFiscalYear(auth, '2024 FY', '2024-01-01', '2024-12-31');
    await fixture.createPeriod(auth, fy2024, '2024-05', '2024-05-01', '2024-05-31');
    const customerId = await createCustomer(auth);
    const all = await taxCodes(auth, 'SALES', false);
    const oldCode = all.find((row) => row.code === 'FI_SALES_STD' && row.effective_to === '2024-08-31');
    const currentCode = all.find((row) => row.code === 'FI_SALES_STD' && row.effective_to === null);
    expect(oldCode).toBeTruthy();
    const oldIssue = await sale(auth, customerId, String(oldCode!.id), '100.00', '2024-05-10');
    const newIssue = await sale(auth, customerId, String(currentCode!.id), '100.00', '2026-09-10');
    expect(String(oldIssue.invoice.tax_total)).toBe('24.00');
    expect(String(newIssue.invoice.tax_total)).toBe('25.50');
    const oldEntry = await journal(auth, String(oldIssue.journal_entry_id));
    const oldVat = oldEntry.lines.find((line: any) => line.tax_leg_type === 'OUTPUT_VAT');
    expect(Number(oldVat.applied_tax_rate)).toBe(24);
  });

  it('inverts VAT on credit notes and reports zero in the summary', async () => {
    const { auth } = await setupTenant('Vat Credit Oy');
    const customerId = await createCustomer(auth);
    const taxCode = await codeId(auth, 'SALES', 'FI_SALES_STD');
    const issued = await sale(auth, customerId, taxCode, '1000.00');
    const credit = await fixture.creditInvoice(auth, String(issued.invoice.id));
    const creditEntry = await journal(auth, String(credit.credit_invoice.accounting_journal_entry_id));
    const creditVat = creditEntry.lines.find((line: any) => line.tax_leg_type === 'OUTPUT_VAT');
    expect(Number(creditVat.debit)).toBe(255);
    expect(Number(creditVat.tax_amount_snapshot)).toBe(255);
    const summary = await fixture.request({
      method: 'GET',
      url: '/api/v1/vat-summary?from=2026-09-01&to=2026-09-30',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(summary, 200, 'vat summary');
    const domestic = summary.body.summary.rows.find((row: any) => row.classification === 'DOMESTIC_OUTPUT_VAT');
    expect(Number(domestic.output_amount)).toBe(0);
    expect(Number(summary.body.summary.totals.vat_amount)).toBe(0);
  });

  it('provides a VAT summary over posted output and deductible input VAT', async () => {
    const { auth, expenseAccountId } = await setupTenant('Vat Summary Oy');
    const customerId = await createCustomer(auth);
    const saleCode = await codeId(auth, 'SALES', 'FI_SALES_STD');
    await sale(auth, customerId, saleCode, '1000.00');
    const supplierId = await createSupplier(auth);
    const purchaseCode = await codeId(auth, 'PURCHASE', 'FI_PURCHASE_STD');
    await createPurchase(auth, supplierId, purchaseCode, '100.00', expenseAccountId);
    const summary = await fixture.request({
      method: 'GET',
      url: '/api/v1/vat-summary?from=2026-09-01&to=2026-09-30',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(summary, 200, 'vat summary');
    expect(Number(summary.body.summary.totals.output_amount)).toBe(255);
    expect(Number(summary.body.summary.totals.input_amount)).toBe(25.5);
    expect(Number(summary.body.summary.totals.vat_amount)).toBe(229.5);
  });

  it('protects statutory codes, enforces permissions and blocks closed periods', async () => {
    const { auth, accounts } = await setupTenant('Vat Governance Oy');
    const all = await taxCodes(auth, 'SALES', false);
    const systemId = String(all.find((row) => row.code === 'FI_SALES_STD' && row.effective_to === null)!.id);
    const immutable = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/tax-codes/${systemId}`,
      body: { rate: 20 },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(immutable.status).toBe(409);
    expect(immutable.body.error.code).toBe('TAX-004');

    const viewer = await fixture.registerUser();
    await addMember(auth, viewer, 'Accountant');
    const summary = await fixture.request({
      method: 'GET',
      url: '/api/v1/vat-summary?from=2026-09-01&to=2026-09-30',
      cookie: viewer.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(summary, 200, 'accountant vat summary');
    const forbidden = await fixture.request({
      method: 'POST',
      url: '/api/v1/tax-codes',
      body: { code: 'CUSTOM', name: 'Custom', country_code: 'FI', rate: 20, type: 'VAT', effective_from: '2026-01-01' },
      cookie: viewer.cookie,
      csrf: viewer.csrf,
      tenantId: auth.tenantId,
    });
    expect(forbidden.status).toBe(403);

    const customerId = await createCustomer(auth);
    const saleCode = await codeId(auth, 'SALES', 'FI_SALES_STD');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Locked', quantity: '1', unit_price: '10', tax_code_id: saleCode }],
    );
    const close = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${accounts.periodId}`,
      body: { status: 'CLOSED' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(close, 200, 'close period');
    const issue = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(issue.status).toBe(409);
    expect(['PERIOD-002', 'PERIOD-003']).toContain(issue.body.error.code);
  });

  it('retries do not duplicate posted VAT journals', async () => {
    const { auth } = await setupTenant('Vat Idempotency Oy');
    const customerId = await createCustomer(auth);
    const taxCode = await codeId(auth, 'SALES', 'FI_SALES_STD');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Idempotent', quantity: '1', unit_price: '100', tax_code_id: taxCode }],
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const retry = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(retry.status).toBe(409);
    const count = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS count FROM journal_entries
         WHERE tenant_id = $1 AND source_type = 'SALES_INVOICE' AND source_id = $2 AND status = 'POSTED'`,
        [auth.tenantId, draft.id],
      );
      return Number(result.rows[0].count);
    });
    expect(count).toBe(1);
    void issued;
  });
});
