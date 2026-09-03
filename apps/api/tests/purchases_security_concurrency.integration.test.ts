import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { withTenantTransaction } from '../src/services/tenantService';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;
const finvoiceFixture = `
<Finvoice>
  <InvoiceDetails>
    <InvoiceNumber>FV-RACE-001</InvoiceNumber>
    <InvoiceDate>2026-09-01</InvoiceDate>
    <InvoiceCurrencyCode>EUR</InvoiceCurrencyCode>
    <InvoiceTotalVatExcluded>100.00</InvoiceTotalVatExcluded>
    <InvoiceTotalVatIncluded>124.00</InvoiceTotalVatIncluded>
  </InvoiceDetails>
  <SellerPartyDetails><SellerPartyIdentifier>FI12345678</SellerPartyIdentifier>
    <SellerName>Race Supplier Oy</SellerName><SellerVatID>FI12345678</SellerVatID></SellerPartyDetails>
  <InvoiceRow><ArticleName>Item</ArticleName><Quantity>1</Quantity><UnitPriceAmount>100</UnitPriceAmount>
    <RowVatExcludedAmount>100</RowVatExcludedAmount><RowVatRatePercent>24</RowVatRatePercent>
    <RowVatRateAmount>24</RowVatRateAmount><RowVatIncludedAmount>124</RowVatIncludedAmount></InvoiceRow>
</Finvoice>`;

describe.skipIf(!databaseUrl)('v0.7 purchase security and races', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
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
    fixture = new SalesFixture(app, pool, 'pursec');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function tenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    const expenseAccountId = await fixture.createAccount(auth, '5000', 'Expense', 'EXPENSE');
    const apAccountId = await fixture.createAccount(auth, '2400', 'AP', 'LIABILITY');
    const inputVatAccountId = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: apAccountId,
        default_expense_account_id: expenseAccountId,
        input_vat_account_id: inputVatAccountId,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    return { auth, accounts, expenseAccountId };
  }

  async function supplier(auth: any, name = 'Race Supplier Oy', businessId = 'FI12345678') {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: { name, business_id: businessId, vat_id: businessId, country_code: 'FI' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'supplier create');
    return result.body.supplier as any;
  }

  async function draftInvoice(auth: any, accounts: any, expenseAccountId: string, supplierId: string, number = 'PO-RACE') {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        supplier_id: supplierId,
        supplier_invoice_number: number,
        invoice_date: '2026-09-10',
        lines: [{ description: 'Racing', quantity: '1', unit_price: '100', tax_code_id: accounts.taxStandardId, expense_account_id: expenseAccountId }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'draft create');
    return result.body.purchase as any;
  }

  async function readyInvoice(auth: any, accounts: any, expenseAccountId: string, supplierId: string, number = 'PO-RACE') {
    const draft = await draftInvoice(auth, accounts, expenseAccountId, supplierId, number);
    await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${draft.id}/review`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    return draft;
  }

  it('enforces permissions and cross-tenant purchase isolation', async () => {
    const tenantA = await tenant('Purchase Sec A Oy');
    const tenantB = await tenant('Purchase Sec B Oy');
    const supplierA = await supplier(tenantA.auth);
    const invoiceA = await draftInvoice(tenantA.auth, tenantA.accounts, tenantA.expenseAccountId, supplierA.id, 'PO-SEC');

    const noContext = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM business_parties WHERE is_supplier) AS suppliers,
         (SELECT count(*)::int FROM purchase_invoices) AS purchases`,
    );
    expect(noContext.rows[0]!.suppliers).toBe(0);
    expect(noContext.rows[0]!.purchases).toBe(0);

    const readFromB = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${invoiceA.id}`,
      cookie: tenantB.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(readFromB, 404, 'cross-tenant purchase read');
    const supplierFromB = await fixture.request({
      method: 'GET',
      url: `/api/v1/suppliers/${supplierA.id}`,
      cookie: tenantB.auth.cookie,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(supplierFromB, 404, 'cross-tenant supplier read');
    const approveFromB = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${invoiceA.id}/approve`,
      cookie: tenantB.auth.cookie,
      csrf: tenantB.auth.csrf,
      tenantId: tenantB.auth.tenantId,
    });
    expectStatus(approveFromB, 404, 'cross-tenant approve');

    const viewer = await fixture.registerUser();
    await fixture.request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email: viewer.email, role_name: 'Viewer' },
      cookie: tenantA.auth.cookie,
      csrf: tenantA.auth.csrf,
      tenantId: tenantA.auth.tenantId,
    });
    const viewerAuth = { cookie: viewer.cookie, csrf: viewer.csrf, tenantId: tenantA.auth.tenantId };
    const viewerApprove = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${invoiceA.id}/review`,
      cookie: viewerAuth.cookie,
      csrf: viewerAuth.csrf,
      tenantId: viewerAuth.tenantId,
    });
    expectStatus(viewerApprove, 403, 'viewer cannot review');
  });

  it('keeps POSTED purchase invoices immutable at the DB level', async () => {
    const t = await tenant('Purchase DB Immutable Oy');
    const sup = await supplier(t.auth, 'Immutable Supplier Oy', 'FI33333333');
    const invoice = await readyInvoice(t.auth, t.accounts, t.expenseAccountId, sup.id, 'PO-IMM');
    await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${invoice.id}/approve`,
      cookie: t.auth.cookie,
      csrf: t.auth.csrf,
      tenantId: t.auth.tenantId,
    });
    const posted = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${invoice.id}/post`,
      cookie: t.auth.cookie,
      csrf: t.auth.csrf,
      tenantId: t.auth.tenantId,
    });
    expectStatus(posted, 200, 'post');
    const lines = await pool.query(
      'SELECT id FROM purchase_invoice_lines WHERE purchase_invoice_id = $1 AND tenant_id = $2',
      [invoice.id, t.auth.tenantId],
    );
    expect(lines.rows).toHaveLength(0); // RLS: no tenant context
    const attempts: Array<() => Promise<unknown>> = [
      () => withTenantTransaction(pool, t.auth.tenantId, (client) => client.query(`UPDATE purchase_invoices SET total = '0.01' WHERE id = $1`, [invoice.id])),
      () => withTenantTransaction(pool, t.auth.tenantId, (client) => client.query(`DELETE FROM purchase_invoices WHERE id = $1`, [invoice.id])),
    ];
    const lineId = await withTenantTransaction(pool, t.auth.tenantId, (client) =>
      client.query('SELECT id FROM purchase_invoice_lines WHERE purchase_invoice_id = $1', [invoice.id]),
    );
    attempts.push(
      () => withTenantTransaction(pool, t.auth.tenantId, (client) => client.query(`UPDATE purchase_invoice_lines SET net_amount = '0.01' WHERE id = $1`, [lineId.rows[0].id])),
      () => withTenantTransaction(pool, t.auth.tenantId, (client) => client.query(`DELETE FROM purchase_invoice_lines WHERE id = $1`, [lineId.rows[0].id])),
    );
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow();
    }
  });

  it('allows exactly one approval, one posting and one correction under 20 parallel calls', async () => {
    const t = await tenant('Purchase Race Oy');
    const sup = await supplier(t.auth);
    const invoice = await readyInvoice(t.auth, t.accounts, t.expenseAccountId, sup.id, 'PO-RACE1');

    const approveResults = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        fixture.request({
          method: 'POST',
          url: `/api/v1/purchases/${invoice.id}/approve`,
          cookie: t.auth.cookie,
          csrf: t.auth.csrf,
          tenantId: t.auth.tenantId,
        }),
      ),
    );
    expect(approveResults.filter((result) => result.status === 'fulfilled' && result.value.status === 200)).toHaveLength(1);

    const postResults = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        fixture.request({
          method: 'POST',
          url: `/api/v1/purchases/${invoice.id}/post`,
          cookie: t.auth.cookie,
          csrf: t.auth.csrf,
          tenantId: t.auth.tenantId,
        }),
      ),
    );
    expect(postResults.filter((result) => result.status === 'fulfilled' && result.value.status === 200)).toHaveLength(1);
    const counts = await withTenantTransaction(pool, t.auth.tenantId, (client) =>
      client.query(
        `SELECT
           (SELECT count(*)::int FROM purchase_invoices WHERE id = $1 AND status = 'POSTED') AS posted,
           (SELECT count(*)::int FROM journal_entries WHERE tenant_id = $2 AND source_type = 'PURCHASE_INVOICE' AND source_id = $1) AS journals,
           (SELECT count(*)::int FROM purchase_invoice_approvals WHERE purchase_invoice_id = $1 AND action = 'APPROVED') AS approvals`,
        [invoice.id, t.auth.tenantId],
      ),
    );
    expect(counts.rows[0]!.posted).toBe(1);
    expect(counts.rows[0]!.journals).toBe(1);
    expect(counts.rows[0]!.approvals).toBe(1);

    const correctResults = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        fixture.request({
          method: 'POST',
          url: `/api/v1/purchases/${invoice.id}/correct`,
          body: { reason: 'Race correction' },
          cookie: t.auth.cookie,
          csrf: t.auth.csrf,
          tenantId: t.auth.tenantId,
        }),
      ),
    );
    expect(correctResults.filter((result) => result.status === 'fulfilled' && result.value.status === 200)).toHaveLength(1);
    const corrected = await withTenantTransaction(pool, t.auth.tenantId, (client) =>
      client.query(
        `SELECT
           (SELECT count(*)::int FROM purchase_invoices WHERE id = $1 AND status = 'CORRECTED') AS corrected,
           (SELECT count(*)::int FROM purchase_invoice_corrections WHERE purchase_invoice_id = $1) AS corrections`,
        [invoice.id],
      ),
    );
    expect(corrected.rows[0]!.corrected).toBe(1);
    expect(corrected.rows[0]!.corrections).toBe(1);
  }, 60_000);

  it('creates exactly one purchase invoice for the same external event under 20 parallel imports', async () => {
    const t = await tenant('Purchase Import Race Oy');
    await supplier(t.auth);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        fixture.request({
          method: 'POST',
          url: '/api/v1/purchases/import',
          body: { format: 'FINVOICE', content: finvoiceFixture },
          cookie: t.auth.cookie,
          csrf: t.auth.csrf,
          tenantId: t.auth.tenantId,
        }),
      ),
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const unexpected = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === 'fulfilled' && ![200, 201, 409].includes(result.value.status),
    );
    const ok = results.filter(
      (result): result is PromiseFulfilledResult<any> =>
        result.status === 'fulfilled' && [200, 201].includes(result.value.status),
    );
    if (ok.length === 0 || rejected.length > 0 || unexpected.length > 0) {
      throw new Error(
        `import race: ok=${ok.length} rejected=${rejected
          .map((result) => String(result.reason))
          .join(' | ')} unexpected=${unexpected.map((result) => result.value.status).join(',')}`,
      );
    }
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const count = await withTenantTransaction(pool, t.auth.tenantId, (client) =>
      client.query(
        `SELECT count(*)::int AS count FROM purchase_invoices
         WHERE tenant_id = $1 AND source_type = 'FINVOICE'`,
        [t.auth.tenantId],
      ),
    );
    expect(count.rows[0]!.count).toBe(1);
  }, 60_000);
});
