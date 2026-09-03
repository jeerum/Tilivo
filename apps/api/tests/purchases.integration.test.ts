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

const finvoiceFixture = `
<Finvoice Version="3.0">
  <InvoiceDetails>
    <InvoiceNumber>FV-TEST-001</InvoiceNumber>
    <InvoiceDate>2026-09-01</InvoiceDate>
    <InvoiceDueDate>2026-09-30</InvoiceDueDate>
    <InvoiceCurrencyCode>EUR</InvoiceCurrencyCode>
    <InvoiceTotalVatExcluded>500.00</InvoiceTotalVatExcluded>
    <InvoiceTotalVatIncluded>620.00</InvoiceTotalVatIncluded>
  </InvoiceDetails>
  <SellerPartyDetails>
    <SellerPartyIdentifier>FI12345678</SellerPartyIdentifier>
    <SellerName>EInvoice Supplier Oy</SellerName>
    <SellerVatID>FI12345678</SellerVatID>
    <SellerAddress><AddressLine1>Testikatu 2</AddressLine1><CountryCode>FI</CountryCode></SellerAddress>
  </SellerPartyDetails>
  <InvoiceRow>
    <ArticleName>Procurement item</ArticleName>
    <Quantity>1</Quantity>
    <UnitPriceAmount>500.00</UnitPriceAmount>
    <RowVatExcludedAmount>500.00</RowVatExcludedAmount>
    <RowVatRatePercent>24</RowVatRatePercent>
    <RowVatRateAmount>120.00</RowVatRateAmount>
    <RowVatIncludedAmount>620.00</RowVatIncludedAmount>
  </InvoiceRow>
</Finvoice>`;

describe.skipIf(!databaseUrl)('v0.7 purchases', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-pdf-'));
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
    fixture = new SalesFixture(app, pool, 'purch');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function purchaseTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    const expenseAccountId = await fixture.createAccount(auth, '5000', 'Purchases expense', 'EXPENSE');
    const apAccountId = await fixture.createAccount(auth, '2400', 'Accounts payable', 'LIABILITY');
    const inputVatAccountId = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    const settings = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: apAccountId,
        default_expense_account_id: expenseAccountId,
        input_vat_account_id: inputVatAccountId,
        auto_post_on_approval: false,
        require_separate_approver: false,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(settings, 200, 'purchase settings');
    return { auth, accounts, expenseAccountId, apAccountId, inputVatAccountId };
  }

  async function createSupplier(auth: any, name = 'Purchase Supplier Oy', businessId = 'FI11111111') {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: {
        name,
        business_id: businessId,
        vat_id: businessId,
        country_code: 'FI',
        default_currency: 'EUR',
        iban: 'FI2112345600000785',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create supplier');
    return result.body.supplier as any;
  }

  async function createPurchaseDraft(auth: any, supplierId: string, taxCodeId: string, expenseAccountId: string, qty = '2') {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        supplier_id: supplierId,
        supplier_invoice_number: 'PO-2026-001',
        invoice_date: '2026-09-10',
        due_date: '2026-10-10',
        lines: [
          {
            description: 'Purchased materials',
            quantity: qty,
            unit_price: '500.00',
            tax_code_id: taxCodeId,
            expense_account_id: expenseAccountId,
          },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'purchase draft');
    return result.body.purchase as any;
  }

  async function transition(auth: any, purchaseId: string, action: string, body?: Record<string, unknown>) {
    const result = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${purchaseId}/${action}`,
      body,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 200, `purchase ${action}`);
    return result.body;
  }

  it('runs the manual purchase lifecycle through posting, immutability and correction', async () => {
    const tenant = await purchaseTenant('Purchase Lifecycle Oy');
    const supplier = await createSupplier(tenant.auth);
    const draft = await createPurchaseDraft(
      tenant.auth,
      supplier.id,
      tenant.accounts.taxStandardId,
      tenant.expenseAccountId,
    );
    expect(draft.status).toBe('DRAFT');
    expect(String(draft.total)).toBe('1240.00');
    expect(draft.supplier_snapshot.name).toBe('Purchase Supplier Oy');

    // Source document attachment while draft.
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1'),
      Buffer.from([0, 1, 2]),
    ]);
    const boundary = '----tilivo-purchase';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="supplier.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        'latin1',
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
    ]);
    const appUpload = await app.inject({
      method: 'POST',
      url: `/api/v1/purchases/${draft.id}/documents`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: tenant.auth.cookie,
        'x-csrf-token': tenant.auth.csrf,
        'x-tilivo-tenant-id': tenant.auth.tenantId,
      },
      payload: body,
    });
    expect(appUpload.statusCode).toBe(201);
    const docList = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${draft.id}/documents`,
      cookie: tenant.auth.cookie,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(docList, 200, 'purchase documents');
    expect(docList.body.documents).toHaveLength(1);
    expect(docList.body.documents[0]!.role).toBe('SOURCE');
    expect(String(docList.body.documents[0]!.sha256)).toMatch(/^[0-9a-f]{64}$/);

    const reviewed = await transition(tenant.auth, draft.id, 'review');
    expect(reviewed.purchase.status).toBe('READY_FOR_APPROVAL');
    const approved = await transition(tenant.auth, draft.id, 'approve');
    expect(approved.purchase.status).toBe('APPROVED');
    const posted = await transition(tenant.auth, draft.id, 'post');
    expect(posted.purchase.status).toBe('POSTED');
    expect(posted.purchase.accounting_journal_entry_id).toBeTruthy();

    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${posted.purchase.accounting_journal_entry_id}`,
      cookie: tenant.auth.cookie,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(journal, 200, 'purchase journal');
    expect(journal.body.journal.source_type).toBe('PURCHASE_INVOICE');
    expect(journal.body.journal.status).toBe('POSTED');
    const lines = journal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    const expense = lines.find((line) => line.account_code === '5000');
    const inputVat = lines.find((line) => line.account_code === '1710');
    const ap = lines.find((line) => line.account_code === '2400');
    expect(Number(expense?.debit)).toBe(1000);
    expect(Number(inputVat?.debit)).toBe(240);
    expect(Number(ap?.credit)).toBe(1240);

    const trial = await fixture.request({
      method: 'GET',
      url: '/api/v1/reports/trial-balance',
      cookie: tenant.auth.cookie,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(trial, 200, 'trial balance');
    expect(trial.body.balanced).toBe(true);

    // Posted purchase cannot be silently edited or deleted.
    const patchPosted = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/purchases/${draft.id}`,
      body: {
        supplier_id: supplier.id,
        invoice_date: '2026-09-10',
        lines: [{ description: 'x', quantity: '1', unit_price: '1', tax_code_id: tenant.accounts.taxStandardId, expense_account_id: tenant.expenseAccountId }],
      },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(patchPosted, 409, 'posted edit denied');
    await expect(
      withTenantTransaction(pool, tenant.auth.tenantId, (client) =>
        client.query(`UPDATE purchase_invoices SET total = '1.00' WHERE id = $1`, [draft.id]),
      ),
    ).rejects.toThrow();

    const correction = await transition(tenant.auth, draft.id, 'correct', { reason: 'Wrong quantity - reversal' });
    expect(correction.invoice.status).toBe('CORRECTED');
    const after = await fixture.request({
      method: 'GET',
      url: '/api/v1/reports/trial-balance',
      cookie: tenant.auth.cookie,
      tenantId: tenant.auth.tenantId,
    });
    expect(after.body.balanced).toBe(true);
    expect(Number(after.body.totals.debit)).toBe(0);
    expect(Number(after.body.totals.credit)).toBe(0);
  }, 30_000);

  it('ingests Finvoice idempotently and matches suppliers deterministically', async () => {
    const tenant = await purchaseTenant('Purchase Import Oy');
    await createSupplier(tenant.auth, 'EInvoice Supplier Oy', 'FI12345678');
    const first = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases/import',
      body: { format: 'FINVOICE', content: finvoiceFixture },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(first, 201, 'finvoice import');
    expect(first.body.purchase.status).toBe('NEEDS_REVIEW');
    expect(first.body.purchase.supplier_id).toBeTruthy();
    expect(String(first.body.purchase.total)).toBe('620.00');
    const second = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases/import',
      body: { format: 'FINVOICE', content: finvoiceFixture },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(second, 200, 'duplicate finvoice import');
    expect(second.body.duplicate).toBe(true);
    expect(String(second.body.purchase.id)).toBe(String(first.body.purchase.id));
    const count = await withTenantTransaction(pool, tenant.auth.tenantId, (client) =>
      client.query(
        `SELECT count(*)::int AS count FROM purchase_invoices
         WHERE tenant_id = $1 AND source_type = 'FINVOICE'`,
        [tenant.auth.tenantId],
      ),
    );
    expect(count.rows[0]!.count).toBe(1);

    // Manual exact duplicate is blocked.
    const supplier = await createSupplier(tenant.auth, 'Manual Dup Oy', 'FI22222222');
    await createPurchaseDraft(tenant.auth, supplier.id, tenant.accounts.taxStandardId, tenant.expenseAccountId);
    const duplicate = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        supplier_id: supplier.id,
        supplier_invoice_number: 'PO-2026-001',
        invoice_date: '2026-09-10',
        lines: [{ description: 'again', quantity: '1', unit_price: '10', tax_code_id: tenant.accounts.taxStandardId, expense_account_id: tenant.expenseAccountId }],
      },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(duplicate, 409, 'duplicate supplier invoice');
  });

  it('enforces separate approver separation of duties', async () => {
    const tenant = await purchaseTenant('Purchase Approval Oy');
    await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: { require_separate_approver: true },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    const supplier = await createSupplier(tenant.auth);
    const draft = await createPurchaseDraft(tenant.auth, supplier.id, tenant.accounts.taxStandardId, tenant.expenseAccountId);
    await transition(tenant.auth, draft.id, 'review');
    const selfApprove = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${draft.id}/approve`,
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    expectStatus(selfApprove, 403, 'creator cannot self approve');

    const member = await fixture.registerUser();
    await fixture.request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email: member.email, role_name: 'Accountant' },
      cookie: tenant.auth.cookie,
      csrf: tenant.auth.csrf,
      tenantId: tenant.auth.tenantId,
    });
    const accountantAuth = {
      cookie: member.cookie,
      csrf: member.csrf,
      tenantId: tenant.auth.tenantId,
    };
    const approveByOther = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${draft.id}/approve`,
      cookie: accountantAuth.cookie,
      csrf: accountantAuth.csrf,
      tenantId: accountantAuth.tenantId,
    });
    expectStatus(approveByOther, 200, 'separate approver allowed');
  });
});
