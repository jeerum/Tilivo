import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { withTenantTransaction } from './tenantService';
import { getInvoiceForPdf } from './salesService';
import { pdfSha256, renderInvoicePdf } from './invoicePdf';
import { writeAuditEventStandalone } from './audit';
import type { OutboxEvent } from './integrationQueue';
import type { LocalObjectStorageProvider } from './documentStorage';

/**
 * Handles a SALES_INVOICE_PDF_REQUESTED outbox event idempotently.
 *
 * The invoice PDF row is locked first; a duplicate job that arrives after a
 * successful render is a no-op. Renders inside the tenant-scoped transaction
 * so the worker role can only see data of that tenant.
 */
export async function processPdfRequest(
  pool: Db,
  storage: LocalObjectStorageProvider,
  event: OutboxEvent,
): Promise<void> {
  const tenantId = event.tenant_id;
  const invoiceId = event.aggregate_id;
  try {
    await withTenantTransaction(pool, tenantId, async (client) => {
      const pdfRow = await client.query(
        `SELECT id, status FROM sales_invoice_pdfs
         WHERE invoice_id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [invoiceId, tenantId],
      );
      if (!pdfRow.rows[0]) {
        throw new Error('sales_invoice_pdf row is missing for issued invoice');
      }
      if (pdfRow.rows[0].status === 'READY') return; // idempotent duplicate job
      await client.query(
        `UPDATE sales_invoice_pdfs
         SET attempt_count = attempt_count + 1, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [pdfRow.rows[0].id, tenantId],
      );
      const invoice = await getInvoiceForPdf(client, tenantId, invoiceId);
      if (!['ISSUED', 'CREDITED'].includes(String(invoice.status))) {
        throw new Error(`invoice ${invoiceId} is not issued`);
      }
      const data = renderInvoicePdf(invoice);
      const sha256 = pdfSha256(data);
      const storageKey = `${tenantId}/sales-invoices/${invoiceId}/${randomUUID()}.pdf`;
      await storage.put(storageKey, data);

      const document = await client.query(
        `INSERT INTO documents (tenant_id, type, status)
         VALUES ($1, 'SALES_INVOICE_PDF', 'UPLOADED')
         RETURNING id`,
        [tenantId],
      );
      const documentId = String(document.rows[0].id);
      const filename = `invoice-${String(invoice.invoice_number ?? invoiceId)}.pdf`;
      await client.query(
        `INSERT INTO document_versions
           (tenant_id, document_id, version_number, storage_key, original_filename,
            mime_type, size_bytes, sha256)
         VALUES ($1, $2, 1, $3, $4, 'application/pdf', $5, $6)`,
        [tenantId, documentId, storageKey, filename, data.length, sha256],
      );
      await client.query(
        `UPDATE sales_invoice_pdfs
         SET status = 'READY', document_id = $2, sha256 = $3, size_bytes = $4,
             failure_reason = NULL, updated_at = now()
         WHERE id = $1 AND tenant_id = $5`,
        [pdfRow.rows[0].id, documentId, sha256, data.length, tenantId],
      );
    });
    await writeAuditEventStandalone(pool, 'SALES_INVOICE.PDF_READY', {
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId },
    }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : 'PDF generation failed';
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE sales_invoice_pdfs
         SET status = 'FAILED', failure_reason = $3, updated_at = now()
         WHERE invoice_id = $1 AND tenant_id = $2 AND status <> 'READY'`,
        [invoiceId, tenantId, message],
      );
    }).catch(() => undefined);
    await writeAuditEventStandalone(pool, 'SALES_INVOICE.PDF_FAILED', {
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId, reason: message },
    }).catch(() => undefined);
    throw error;
  }
}
