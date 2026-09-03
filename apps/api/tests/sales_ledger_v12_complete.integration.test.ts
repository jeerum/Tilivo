import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { SalesFixture, expectStatus } from './salesTestSupport';
import { getDocumentDownload, LocalObjectStorageProvider } from '../src/services/documentStorage';
import { processPdfRequest, processReminderPdfRequest } from '../src/services/invoicePdfWorker';
import { getInvoicePdfMetadata, getReminderPdfMetadata } from '../src/services/salesService';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.12 sales ledger completion', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;
  let storage: LocalObjectStorageProvider;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-v12-complete-'));
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
    fixture = new SalesFixture(app, pool, 'v12complete');
    workerPool = createPool(process.env.WORKER_TEST_DATABASE_URL!);
    storage = new LocalObjectStorageProvider(storageDir);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setup(name: string, extra: Record<string, unknown> = {}) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    const advanceAccountId = await fixture.createAccount(auth, '2990', 'Advances received', 'LIABILITY');
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
      advanceAccountId,
      bankIban: 'FI21 1234 5600 0007 85',
      bankBic: 'OKOYFIHH',
      bankHolder: 'Tilivo QA Oy',
      ...extra,
    });
    const customerId = await fixture.createCustomer(auth, 'Completion Customer Oy', {
      email: 'completion@example.com',
      e_invoice_address: 'OPERATOOR:00371234567',
      e_invoice_operator: '00371234567',
      e_invoice_ovt: '00371234567',
      delivery_method: 'EMAIL',
    });
    return { auth, customerId, accounts, advanceAccountId };
  }

  async function processInvoicePdf(tenantId: string, invoiceId: string): Promise<Buffer> {
    const outbox = await workerPool.query(
      `SELECT id, tenant_id, aggregate_id, event_type FROM integration_outbox
       WHERE tenant_id = $1 AND event_type = 'SALES_INVOICE_PDF_REQUESTED'
         AND aggregate_id = $2 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, invoiceId],
    );
    expect(outbox.rows).toHaveLength(1);
    await processPdfRequest(workerPool, storage, {
      id: String(outbox.rows[0].id),
      tenant_id: String(outbox.rows[0].tenant_id),
      aggregate_id: String(outbox.rows[0].aggregate_id),
      aggregate_type: 'sales_invoice',
      event_type: String(outbox.rows[0].event_type),
      payload: '{}',
      attempt_count: 0,
    });
    const pdf = await getInvoicePdfMetadata(pool, tenantId, invoiceId);
    const download = await getDocumentDownload(pool, tenantId, String(pdf.document_id));
    return storage.get(download.storageKey);
  }

  it('applies invoice-level discounts before VAT and freezes totals', async () => {
    const { auth, customerId, accounts } = await setup('Discount Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        { description: 'Std', quantity: '1', unit_price: '1000.00', tax_code_id: accounts.taxStandardId },
        { description: 'Reduced', quantity: '1', unit_price: '500.00', tax_code_id: accounts.taxReducedId },
      ],
      { issue_date: '2026-09-10', discount_percent: '10' },
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoice = issued.invoice;
    expect(String(invoice.discount_percent)).toBe('10.00');
    expect(String(invoice.discount_amount)).toBe('150.00');
    // line nets after discount: 900 + 450 = 1350; VAT 24%*900=216 + 14%*450=63 = 279
    expect(String(invoice.subtotal)).toBe('1350.00');
    expect(String(invoice.tax_total)).toBe('279.00');
    expect(String(invoice.total)).toBe('1629.00');
    const pdf = await processInvoicePdf(auth.tenantId, draft.id);
    const pdfText = pdf.toString('latin1').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
    expect(pdfText).toContain('Discount');
    expect(pdfText).toContain('FI21 1234 5600 0007 85');
    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${invoice.accounting_journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const lines = journal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    const ar = lines.find((line) => line.account_code === '1700');
    expect(Number(ar?.debit)).toBeCloseTo(1629, 2);
  });

  it('supports partial credits, over-credit rejection and full-remaining credits', async () => {
    const { auth, customerId, accounts } = await setup('Partial Credit Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        { description: 'Item A', quantity: '1', unit_price: '1000.00', tax_code_id: accounts.taxStandardId },
        { description: 'Item B', quantity: '1', unit_price: '100.00', tax_code_id: accounts.taxZeroId },
      ],
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const original = issued.invoice;
    expect(String(original.total)).toBe('1340.00');
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const lineA = (detail.body.invoice.lines as Array<{ id: string; description: string }>)
      .find((line) => line.description === 'Item A')!;
    const lineB = (detail.body.invoice.lines as Array<{ id: string; description: string }>)
      .find((line) => line.description === 'Item B')!;

    const partial = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/credit-note`,
      body: {
        reason: 'Partial return of item A',
        lines: [{ sales_invoice_line_id: lineA.id, quantity: '1', unit_price: '500.00' }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(partial, 201, 'partial credit');
    expect(partial.body.partial).toBe(true);
    expect(String(partial.body.original_invoice.credited_amount)).toBe('620.00');
    expect(partial.body.original_invoice.status).toBe('ISSUED');

    const creditable = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}/creditable`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(creditable.body.creditable.creditable)).toBe('720.00');

    const over = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/credit-note`,
      body: {
        reason: 'Over-credit must fail',
        lines: [{ sales_invoice_line_id: lineA.id, quantity: '1', unit_price: '1000.00' }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    if (over.status !== 400) throw new Error(`over-credit expected 400: ${JSON.stringify(over.body)}`);

    const second = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/credit-note`,
      body: {
        reason: 'Credit the remainder',
        lines: [
          { sales_invoice_line_id: lineA.id, quantity: '1', unit_price: '500.00' },
          { sales_invoice_line_id: lineB.id, quantity: '1', unit_price: '100.00' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(second, 201, 'second partial credit');
    expect(second.body.original_invoice.status).toBe('CREDITED');
    expect(String(second.body.original_invoice.credited_amount)).toBe('1340.00');
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND action = 'SALES_INVOICE.PARTIALLY_CREDITED' AND object_id = $2`,
      [auth.tenantId, draft.id],
    );
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('issues advances without revenue and allocates them on the final invoice once', async () => {
    const { auth, customerId, accounts, advanceAccountId } = await setup('Advance Oy');
    const advanceDraft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Advance on project', quantity: '1', unit_price: '1000.00', tax_code_id: accounts.taxStandardId }],
      { issue_date: '2026-09-08', document_type: 'ADVANCE_INVOICE' },
    );
    const advance = (await fixture.issueInvoice(auth, advanceDraft.id)).invoice;
    expect(String(advance.document_type)).toBe('ADVANCE_INVOICE');
    const advanceJournal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${advance.accounting_journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const advanceLines = advanceJournal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    expect(Number(advanceLines.find((line) => line.account_code === '1700')?.debit)).toBeCloseTo(1240, 2);
    expect(Number(advanceLines.find((line) => line.account_code === '2990')?.credit)).toBeCloseTo(1240, 2);
    expect(advanceLines.filter((line) => line.account_code === '3000')).toHaveLength(0);

    const finalDraft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Full project delivery', quantity: '1', unit_price: '2500.00', tax_code_id: accounts.taxStandardId }],
      { issue_date: '2026-09-20' },
    );
    const issued = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${finalDraft.id}/issue`,
      body: {
        advance_allocations: [{ advance_invoice_id: advanceDraft.id, amount: '1240.00' }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(issued, 200, 'final invoice issue');
    const final = issued.body.invoice;
    expect(String(final.advance_applied)).toBe('1240.00');
    expect(String(final.total)).toBe('3100.00');
    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${final.accounting_journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const lines = journal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    expect(Number(lines.find((line) => line.account_code === '2990')?.debit)).toBeCloseTo(1240, 2);
    expect(Number(lines.find((line) => line.account_code === '1700')?.debit)).toBeCloseTo(1860, 2);
    const revenue = lines.filter((line) => line.account_code === '3000');
    expect(revenue.reduce((sum, line) => sum + Number(line.credit), 0)).toBeCloseTo(2500, 2);

    const reuse = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${finalDraft.id}/issue`,
      body: { advance_allocations: [{ advance_invoice_id: advanceDraft.id, amount: '100.00' }] },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(reuse.status).toBe(409);
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND action = 'SALES_ADVANCE.APPLIED'`,
      [auth.tenantId],
    );
    expect(audit.rows[0]!.n).toBe(1);
    const advanceState = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${finalDraft.id}/advances`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(advanceState.body.advance_state.allocations[0]!.applied_amount)).toBe('1240.00');
    void advanceAccountId;
  });

  it('creates reminders with fee and interest, renders PDF and sends by e-mail', async () => {
    const { auth, customerId, accounts } = await setup('Reminder Oy', {
      lateInterestEnabled: true,
      lateInterestRate: '9.5',
      reminderFeeEnabled: true,
      reminderFeeAmount: '5.00',
    });
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Overdue item', quantity: '1', unit_price: '1000.00', tax_code_id: accounts.taxStandardId }],
      { issue_date: '2026-09-10', due_date: '2026-09-15' },
    );
    await fixture.issueInvoice(auth, draft.id);
    const reminder = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/reminders`,
      body: { note: 'Please pay', level: 1, apply_reminder_fee: true },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reminder, 200, 'create reminder');
    const reminderId = String(reminder.body.reminder.id);
    expect(reminder.body.reminder.pdf_status).toBe('NONE');
    expect(Number(reminder.body.reminder.fee_amount)).toBe(5);
    expect(Number(reminder.body.reminder.amount_due)).toBeGreaterThan(0);

    const pdfReq = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/reminders/${reminderId}/pdf`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(pdfReq, 200, 'request reminder pdf');
    const outbox = await workerPool.query(
      `SELECT id, tenant_id, aggregate_id, event_type FROM integration_outbox
       WHERE tenant_id = $1 AND event_type = 'SALES_REMINDER_PDF_REQUESTED' AND status = 'PENDING'`,
      [auth.tenantId],
    );
    expect(outbox.rows).toHaveLength(1);
    await processReminderPdfRequest(workerPool, storage, {
      id: String(outbox.rows[0].id),
      tenant_id: String(outbox.rows[0].tenant_id),
      aggregate_id: String(outbox.rows[0].aggregate_id),
      aggregate_type: 'sales_reminder',
      event_type: String(outbox.rows[0].event_type),
      payload: '{}',
      attempt_count: 0,
    });
    const pdf = await getReminderPdfMetadata(pool, auth.tenantId, reminderId);
    expect(pdf.pdf_status).toBe('READY');
    const download = await getDocumentDownload(pool, auth.tenantId, String(pdf.pdf_document_id));
    const data = await storage.get(download.storageKey);
    expect(data.toString('latin1')).toContain('MAKSUMUISTUTUS');

    const send = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/reminders/${reminderId}/send`,
      body: { recipient: 'completion@example.com' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(send, 200, 'send reminder');
    expect(send.body.sent).toBe(true);
    const mail = await pool.query(
      `SELECT * FROM dev_email_outbox WHERE recipient_email = 'completion@example.com'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(mail.rows[0]?.attachment_base64).toBeTruthy();
    const history = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/send-history?document_type=SALES_REMINDER&document_id=${reminderId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(history.body.history[0]?.status).toBe('SENT');
  });

  it('provides aging buckets and a customer statement that reconciles', async () => {
    const { auth, customerId, accounts } = await setup('Statement Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Service', quantity: '1', unit_price: '1000.00', tax_code_id: accounts.taxStandardId }],
      { issue_date: '2026-09-10', due_date: '2026-09-15' },
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoiceId = draft.id;
    await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/payments`,
      body: { amount: '400.00', payment_date: '2026-09-20' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    const paymentHistory = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${invoiceId}/payments`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(paymentHistory.body.payments).toHaveLength(1);
    expect(String(paymentHistory.body.payments[0]!.amount)).toBe('400.00');
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${invoiceId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const line = detail.body.invoice.lines[0] as { id: string };
    await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/credit-note`,
      body: {
        reason: 'Partial credit for statement test',
        lines: [{ sales_invoice_line_id: line.id, quantity: '1', unit_price: '500.00' }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });

    const aging = await fixture.request({
      method: 'GET',
      url: '/api/v1/sales/aging?as_of=2026-12-30',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(aging, 200, 'aging');
    const buckets = aging.body.buckets as Array<{ bucket: string; amount: string }>;
    const overdueBucket = buckets.find((bucket) => bucket.bucket === 'OVER_90');
    expect(overdueBucket).toBeTruthy();

    const statement = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/customers/${customerId}/statement?from=2026-08-01&to=2026-10-01`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(statement, 200, 'statement');
    const lines = statement.body.statement.lines as Array<{ debit: string; credit: string; balance: string }>;
    expect(String(statement.body.statement.open_balance)).toBe('220.00');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const balance = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/customers/${customerId}/balance`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(balance.body.balance.open)).toBe('220.00');
    void issued;
  });

  it('exports e-invoice payload readiness with send history', async () => {
    const { auth, customerId, accounts } = await setup('Einvoice Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Delivery', quantity: '1', unit_price: '100.00', tax_code_id: accounts.taxStandardId }],
    );
    await fixture.issueInvoice(auth, draft.id);
    const exported = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${draft.id}/e-invoice/export`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(exported, 200, 'e-invoice export');
    expect(exported.body.payload.format).toBe('TILIVO_EINVOICE_V1');
    expect(exported.body.payload.buyer.e_invoice_address).toBe('OPERATOOR:00371234567');
    expect(exported.body.history.status).toBe('QUEUED');
    const invoice = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(invoice.body.invoice.delivery_status).toBe('EINVOICE_READY');
  });

  it('keeps recurring templates manageable and tenant isolated', async () => {
    const { auth, customerId } = await setup('Recurring Manage Oy');
    const taxList = await fixture.request({
      method: 'GET',
      url: '/api/v1/tax-codes?current=true&direction=SALES',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const std = (taxList.body.tax_codes as Array<{ id: string }>)[0]!.id;
    const created = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/recurring-templates',
      body: {
        customer_id: customerId,
        name: 'Monthly retainer',
        frequency: 'MONTHLY',
        start_date: '2026-09-10',
        payment_terms_days: 14,
        language: 'fi',
        lines: [{ description: 'Retainer', quantity: '1', unit_price: '100.00', tax_code_id: std }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(created, 201, 'create recurring template');
    const templateId = String(created.body.template.id);
    const patched = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/sales/recurring-templates/${templateId}`,
      body: { name: 'Renamed retainer', payment_terms_days: 21 },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(patched, 200, 'update recurring template');
    expect(patched.body.template.name).toBe('Renamed retainer');
    await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/recurring-templates/${templateId}/disable`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const other = await fixture.setupOwner('Other Tenant Oy');
    const crossTenant = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/recurring-templates/${templateId}`,
      cookie: other.cookie,
      tenantId: other.tenantId,
    });
    expect(crossTenant.status).toBe(404);
  });
});
