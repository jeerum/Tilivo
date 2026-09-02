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
import { getDocumentDownload } from '../src/services/documentStorage';
import { getInvoicePdfMetadata } from '../src/services/salesService';
import { pdfSha256 } from '../src/services/invoicePdf';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.6 sales module', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;
  let storage: LocalObjectStorageProvider;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-pdf-'));
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
    fixture = new SalesFixture(app, pool, 'sales');
    workerPool = createPool(process.env.WORKER_TEST_DATABASE_URL!);
    storage = new LocalObjectStorageProvider(storageDir);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setupTenant(): Promise<{
    auth: any;
    customerId: string;
    accounts: Awaited<ReturnType<typeof fixture.standardAccountingSetup>>;
  }> {
    const auth = await fixture.setupOwner('Sales Functional Oy');
    const accounts = await fixture.standardAccountingSetup(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const customerId = await fixture.createCustomer(auth);
    return { auth, customerId, accounts };
  }

  it('supports customer CRUD, invoice draft lifecycle and server-side totals', async () => {
    const { auth, customerId, accounts } = await setupTenant();

    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        { description: 'Consulting', quantity: '2', unit_price: '500', tax_code_id: accounts.taxStandardId },
        {
          description: 'Materials',
          quantity: '1',
          unit_price: '19.99',
          discount_percent: '10',
          tax_code_id: accounts.taxStandardId,
        },
        { description: 'Exempt item', quantity: '3', unit_price: '10', tax_code_id: accounts.taxZeroId },
      ],
    );
    expect(draft.status).toBe('DRAFT');
    expect(draft.invoice_number).toBeNull();
    // line 1: 1000.00 net, 240.00 tax; line 2: 17.99 net, 4.32 tax;
    // line 3: 30.00 net, 0 tax -> totals 1047.99 / 244.32 / 1292.31
    expect(String(draft.subtotal)).toBe('1047.99');
    expect(String(draft.tax_total)).toBe('244.32');
    expect(String(draft.total)).toBe('1292.31');

    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(detail, 200, 'get draft');
    expect(detail.body.invoice.lines).toHaveLength(3);

    // Hostile totals are ignored: patch changes a price; totals recompute.
    const patched = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/sales/invoices/${draft.id}`,
      body: {
        customer_id: customerId,
        issue_date: '2026-09-10',
        subtotal: '1.00',
        tax_total: '0.00',
        total: '1.00',
        lines: [
          { description: 'Consulting', quantity: '3', unit_price: '500', tax_code_id: accounts.taxStandardId },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(patched, 200, 'patch draft');
    expect(String(patched.body.invoice.subtotal)).toBe('1500.00');
    expect(String(patched.body.invoice.tax_total)).toBe('360.00');
    expect(String(patched.body.invoice.total)).toBe('1860.00');

    const cancelledDraft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'To cancel', quantity: '1', unit_price: '5', tax_code_id: accounts.taxStandardId }],
    );
    const cancelled = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${cancelledDraft.id}/cancel-draft`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(cancelled, 200, 'cancel draft');
    expect(cancelled.body.invoice.status).toBe('CANCELLED_DRAFT');
    const cancelIssue = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${cancelledDraft.id}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(cancelIssue, 409, 'canceled draft cannot be issued');

    const list = await fixture.request({
      method: 'GET',
      url: '/api/v1/sales/invoices?status=DRAFT&limit=20',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(list, 200, 'list drafts');
    expect(list.body.total).toBeGreaterThanOrEqual(1);
  });

  it('issues an invoice atomically with number, reference, journal and PDF', async () => {
    const { auth, customerId, accounts } = await setupTenant();
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        { description: 'Consulting', quantity: '2', unit_price: '500', tax_code_id: accounts.taxStandardId },
        { description: 'Exempt', quantity: '1', unit_price: '100', tax_code_id: accounts.taxZeroId },
      ],
      { issue_date: '2026-09-10' },
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoice = issued.invoice;
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.invoice_number).toMatch(/^2026-000001$/);
    expect(invoice.payment_reference).toMatch(/^\d+$/);
    expect(invoice.accounting_journal_entry_id).toBeTruthy();
    expect(invoice.customer_snapshot.name).toBe('Acme Customer Oy');
    expect(String(invoice.total)).toBe('1340.00');
    expect(String(invoice.tax_total)).toBe('240.00');
    expect(String(invoice.subtotal)).toBe('1100.00');

    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${invoice.accounting_journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(journal, 200, 'get journal');
    expect(journal.body.journal.status).toBe('POSTED');
    expect(String(journal.body.journal.source_type)).toBe('SALES_INVOICE');
    expect(String(journal.body.journal.source_id)).toBe(draft.id);
    const lines = journal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    const ar = lines.find((line) => line.account_code === '1700');
    const revenue = lines.filter((line) => line.account_code === '3000');
    const vat = lines.filter((line) => line.account_code === '2930');
    expect(Number(ar?.debit)).toBe(1340);
    expect(revenue.reduce((sum, line) => sum + Number(line.credit), 0)).toBeCloseTo(1100, 2);
    expect(vat.reduce((sum, line) => sum + Number(line.credit), 0)).toBeCloseTo(240, 2);

    // PDF outbox -> worker renders and stores deterministic bytes.
    const outbox = await workerPool.query(
      `SELECT id, tenant_id, aggregate_id, event_type FROM integration_outbox
       WHERE tenant_id = $1 AND event_type = 'SALES_INVOICE_PDF_REQUESTED' AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [auth.tenantId],
    );
    expect(outbox.rows).toHaveLength(1);
    const event = {
      id: String(outbox.rows[0].id),
      tenant_id: String(outbox.rows[0].tenant_id),
      aggregate_id: String(outbox.rows[0].aggregate_id),
      aggregate_type: 'sales_invoice',
      event_type: String(outbox.rows[0].event_type),
      payload: '{}',
      attempt_count: 0,
    };
    await processPdfRequest(workerPool, storage, event);

    const pdfMeta = await getInvoicePdfMetadata(pool, auth.tenantId, draft.id);
    expect(pdfMeta.status).toBe('READY');
    expect(pdfMeta.sha256).toMatch(/^[0-9a-f]{64}$/);
    const download = await getDocumentDownload(pool, auth.tenantId, String(pdfMeta.document_id));
    const data = await storage.get(download.storageKey);
    expect(pdfSha256(data)).toBe(String(pdfMeta.sha256));
    expect(data.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const pdfResponse = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${draft.id}/pdf`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(pdfResponse.status).toBe(200);
    const issuedAudit = await pool.query(
      `SELECT count(*)::int AS count FROM audit_events
       WHERE tenant_id = $1 AND action = 'SALES_INVOICE.ISSUED' AND object_id = $2`,
      [auth.tenantId, draft.id],
    );
    expect(issuedAudit.rows[0]!.count).toBe(1);
  });

  it('credits an issued invoice with an inverse journal and zero net effect', async () => {
    const { auth, customerId, accounts } = await setupTenant();
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [
        { description: 'Consulting', quantity: '1', unit_price: '1000', tax_code_id: accounts.taxStandardId },
        { description: 'Exempt', quantity: '1', unit_price: '100', tax_code_id: accounts.taxZeroId },
      ],
      { issue_date: '2026-09-12' },
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const original = issued.invoice;
    expect(String(original.total)).toBe('1340.00');

    const credit = await fixture.creditInvoice(auth, draft.id, 'Wrong quantity - full credit');
    expect(credit.original_invoice.status).toBe('CREDITED');
    expect(String(credit.original_invoice.credited_by_invoice_id)).toBe(credit.credit_invoice.id);
    expect(credit.credit_invoice.status).toBe('ISSUED');
    expect(credit.credit_invoice.invoice_number).toMatch(/^2026-000002$/);
    expect(String(credit.credit_invoice.total)).toBe('1340.00');
    expect(credit.credit_invoice.accounting_journal_entry_id).toBeTruthy();

    const creditJournal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${credit.credit_invoice.accounting_journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(creditJournal, 200, 'get credit journal');
    expect(creditJournal.body.journal.source_type).toBe('SALES_CREDIT_NOTE');
    const creditLines = creditJournal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    const ar = creditLines.find((line) => line.account_code === '1700');
    expect(Number(ar?.credit)).toBe(1340);

    const trial = await fixture.request({
      method: 'GET',
      url: '/api/v1/reports/trial-balance',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(trial, 200, 'trial balance');
    expect(Number(trial.body.totals.debit)).toBe(0);
    expect(Number(trial.body.totals.credit)).toBe(0);
    expect(trial.body.balanced).toBe(true);
  });

  it('denies mutations of issued invoices at the API layer', async () => {
    const { auth, customerId, accounts } = await setupTenant();
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Consulting', quantity: '1', unit_price: '10', tax_code_id: accounts.taxStandardId }],
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoiceId = issued.invoice.id as string;
    const update = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/sales/invoices/${invoiceId}`,
      body: {
        customer_id: customerId,
        issue_date: '2026-09-10',
        lines: [{ description: 'Changed', quantity: '1', unit_price: '99', tax_code_id: accounts.taxStandardId }],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(update, 409, 'issued invoice update denied');
    const secondIssue = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(secondIssue, 409, 'double issue denied');
  });

  it('requires authentication and CSRF for sales routes', async () => {
    const unauth = await fixture.request({ method: 'GET', url: '/api/v1/customers' });
    expectStatus(unauth, 401, 'customers require auth');
    const { auth, customerId, accounts } = await setupTenant();
    const noCsrf = await fixture.request({
      method: 'POST',
      url: '/api/v1/sales/invoices',
      body: {
        customer_id: customerId,
        lines: [{ description: 'x', quantity: '1', unit_price: '1', tax_code_id: accounts.taxStandardId }],
      },
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(noCsrf, 403, 'CSRF required');
  });
});
