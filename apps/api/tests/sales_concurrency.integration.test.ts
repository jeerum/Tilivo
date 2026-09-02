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
import { SalesFixture } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.6 sales concurrency and idempotency', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storage: LocalObjectStorageProvider;
  let storageDir: string;

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
    fixture = new SalesFixture(app, pool, 'salesconc');
    workerPool = createPool(process.env.WORKER_TEST_DATABASE_URL!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-conc-pdf-'));
    storage = new LocalObjectStorageProvider(storageDir);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function setupTenant(name: string) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const customerId = await fixture.createCustomer(auth);
    return { auth, accounts, customerId };
  }

  it('assigns unique invoice numbers for 100 parallel issues', async () => {
    const { auth, customerId, accounts } = await setupTenant('Sales 100 Parallel Oy');
    const drafts: any[] = [];
    for (let index = 0; index < 100; index += 1) {
      drafts.push(
        await fixture.createDraft(
          auth,
          customerId,
          [
            {
              description: `Parallel line ${index}`,
              quantity: '1',
              unit_price: '1.00',
              tax_code_id: accounts.taxStandardId,
            },
          ],
        ),
      );
    }
    const results = await Promise.allSettled(
      drafts.map((draft) => fixture.issueInvoice(auth, String(draft.id))),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled',
    );
    const rejectedReasons = results
      .filter((result) => result.status === 'rejected')
      .map((result) => String((result as PromiseRejectedResult).reason));
    if (fulfilled.length !== 100) {
      throw new Error(
        `expected 100 successful issues, got ${fulfilled.length}: ${rejectedReasons.join(' | ')}`,
      );
    }
    const numbers = fulfilled.map((result) => String(result.value.invoice.invoice_number));
    expect(new Set(numbers).size).toBe(100);
    for (const number of numbers) {
      expect(number).toMatch(/^2026-\d{6}$/);
    }
    const counts = await withTenantTransaction(pool, auth.tenantId, (client) => client.query(
      `SELECT count(*)::int AS issued,
              count(DISTINCT invoice_number)::int AS distinct_numbers,
              (SELECT count(*)::int FROM journal_entries
               WHERE tenant_id = $1 AND source_type = 'SALES_INVOICE') AS journals
       FROM sales_invoices WHERE tenant_id = $1 AND status = 'ISSUED'`,
      [auth.tenantId],
    ));
    expect(counts.rows[0]!.issued).toBe(100);
    expect(counts.rows[0]!.distinct_numbers).toBe(100);
    expect(counts.rows[0]!.journals).toBe(100);
  }, 60_000);

  it('allows exactly one issue for the same draft under 20 parallel requests', async () => {
    const { auth, customerId, accounts } = await setupTenant('Sales Double Issue Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Race draft', quantity: '1', unit_price: '10', tax_code_id: accounts.taxStandardId }],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => fixture.issueInvoice(auth, String(draft.id))),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejectedReasons = results
      .filter((result) => result.status === 'rejected')
      .map((result) => String((result as PromiseRejectedResult).reason));
    if (fulfilled.length !== 1) {
      throw new Error(
        `expected exactly one successful issue, got ${fulfilled.length}: ${rejectedReasons.join(' | ')}`,
      );
    }
    const counts = await withTenantTransaction(pool, auth.tenantId, (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM sales_invoices WHERE id = $1 AND invoice_number IS NOT NULL) AS issued,
         (SELECT count(*)::int FROM journal_entries
          WHERE tenant_id = $2 AND source_type = 'SALES_INVOICE' AND source_id = $1) AS journals,
         (SELECT count(*)::int FROM audit_events
         WHERE tenant_id = $2 AND action = 'SALES_INVOICE.ISSUED' AND object_id = $1) AS audits`,
      [draft.id, auth.tenantId],
    ));
    expect(counts.rows[0]!.issued).toBe(1);
    expect(counts.rows[0]!.journals).toBe(1);
    expect(counts.rows[0]!.audits).toBe(1);
  }, 30_000);

  it('allows exactly one full credit under 20 parallel requests', async () => {
    const { auth, customerId, accounts } = await setupTenant('Sales Credit Race Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Credit race invoice', quantity: '1', unit_price: '50', tax_code_id: accounts.taxStandardId }],
    );
    await fixture.issueInvoice(auth, String(draft.id));
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => fixture.creditInvoice(auth, String(draft.id), 'race credit')),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejectedReasons = results
      .filter((result) => result.status === 'rejected')
      .map((result) => String((result as PromiseRejectedResult).reason));
    if (fulfilled.length !== 1) {
      throw new Error(
        `expected exactly one successful credit, got ${fulfilled.length}: ${rejectedReasons.join(' | ')}`,
      );
    }
    const counts = await withTenantTransaction(pool, auth.tenantId, (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM sales_invoices
          WHERE tenant_id = $1 AND credit_of_invoice_id = $2) AS credit_invoices,
         (SELECT count(*)::int FROM sales_invoice_credit_links
          WHERE tenant_id = $1 AND original_invoice_id = $2) AS links,
         (SELECT count(*)::int FROM journal_entries
          WHERE tenant_id = $1 AND source_type = 'SALES_CREDIT_NOTE') AS credit_journals,
         (SELECT status FROM sales_invoices WHERE id = $2) AS status`,
      [auth.tenantId, draft.id],
    ));
    expect(counts.rows[0]!.credit_invoices).toBe(1);
    expect(counts.rows[0]!.links).toBe(1);
    expect(counts.rows[0]!.credit_journals).toBe(1);
    expect(counts.rows[0]!.status).toBe('CREDITED');
  }, 30_000);

  it('keeps PDF generation and outbox events idempotent', async () => {
    const { auth, customerId, accounts } = await setupTenant('Sales Pdf Idempotent Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Pdf idempotency', quantity: '1', unit_price: '20', tax_code_id: accounts.taxStandardId }],
    );
    await fixture.issueInvoice(auth, String(draft.id));
    const events = await workerPool.query(
      `SELECT id, tenant_id, aggregate_id, event_type FROM integration_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND status = 'PENDING'
       ORDER BY created_at`,
      [auth.tenantId, draft.id],
    );
    const eventTypes = (events.rows as Array<{ event_type: string }>).map((row) => row.event_type).sort();
    expect(eventTypes).toEqual(['SALES_INVOICE_ISSUED', 'SALES_INVOICE_PDF_REQUESTED']);
    const pdfEvent = events.rows.find((row) => row.event_type === 'SALES_INVOICE_PDF_REQUESTED');
    const event = {
      id: String(pdfEvent.id),
      tenant_id: String(pdfEvent.tenant_id),
      aggregate_id: String(pdfEvent.aggregate_id),
      aggregate_type: 'sales_invoice',
      event_type: String(pdfEvent.event_type),
      payload: '{}',
      attempt_count: 0,
    };
    await processPdfRequest(workerPool, storage, event);
    await processPdfRequest(workerPool, storage, event); // duplicate job must be a no-op
    const docs = await withTenantTransaction(pool, auth.tenantId, (client) => client.query(
      `SELECT count(*)::int AS documents
       FROM documents d
       JOIN sales_invoice_pdfs p ON p.document_id = d.id
       WHERE p.tenant_id = $1 AND p.invoice_id = $2`,
      [auth.tenantId, draft.id],
    ));
    expect(docs.rows[0]!.documents).toBe(1);
    const pdfState = await withTenantTransaction(pool, auth.tenantId, (client) => client.query(
      `SELECT status FROM sales_invoice_pdfs
       WHERE tenant_id = $1 AND invoice_id = $2`,
      [auth.tenantId, draft.id],
    ));
    expect(pdfState.rows[0]!.status).toBe('READY');
  }, 30_000);
});
