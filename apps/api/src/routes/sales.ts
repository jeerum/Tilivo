import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  cancelInvoiceDraft,
  appendSendHistory,
  createCreditNote,
  createCustomer,
  createInvoiceDraft,
  createRecurringTemplate,
  createSeries,
  creditInvoice,
  customerBalance,
  customerStatement,
  deleteRecurringTemplate,
  exportEInvoicePayload,
  getCreditableSummary,
  getCustomer,
  getInvoice,
  getInvoicePdfMetadata,
  getReminderPdfMetadata,
  getRecurringTemplate,
  getSalesReminder,
  getInvoiceAdvanceState,
  getSalesSettings,
  issueInvoice,
  listCreditNotes,
  listRecurringTemplates,
  listCustomers,
  listSalesReminders,
  listSalesPayments,
  listSendHistory,
  listInvoices,
  listSeries,
  markReminderSendResult,
  requestReminderPdf,
  salesAging,
  salesLedger,
  recordSalesPayment,
  createSalesReminder,
  generateDueRecurringInvoices,
  retryInvoicePdf,
  setInvoiceDeliveryState,
  setCustomerActive,
  setRecurringTemplateActive,
  updateRecurringTemplate,
  updateCustomer,
  updateInvoiceDraft,
  updateSalesSettings,
  updateSeries,
} from '../services/salesService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess } from '../services/tenantService';
import { writeAuditEvent } from '../services/audit';
import { getDocumentDownload } from '../services/documentStorage';
import type { LocalObjectStorageProvider } from '../services/documentStorage';
import { registryCompanySchema } from '../services/businessRegistryTypes';
import type { EmailProvider } from '../services/emailProvider';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const uuidString = z.string().regex(UUID_RE, 'Invalid UUID');
const dateString = z.string().regex(DATE_RE, 'Invalid date');
const decimalString = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z.string().regex(/^\d+(\.\d+)?$/, 'Invalid decimal'),
);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const registryFields = {
  registry_source: z.string().trim().max(64).nullable().optional(),
  registry_source_id: z.string().trim().max(64).nullable().optional(),
  registry_fetched_at: z.string().datetime({ offset: true }).nullable().optional(),
  registry_snapshot: registryCompanySchema.nullable().optional(),
};

const customerSchema = z.object({
  name: z.string().trim().min(1).max(300),
  is_customer: z.boolean().optional(),
  is_supplier: z.boolean().optional(),
  business_id: nullableText(64),
  vat_id: nullableText(64),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: nullableText(64),
  address_line1: nullableText(300),
  address_line2: nullableText(300),
  postal_code: nullableText(32),
  city: nullableText(120),
  country_code: z.string().trim().length(2).optional(),
  language: z.string().trim().length(2).optional(),
  payment_terms_days: z.number().int().min(0).max(3650).optional(),
  default_currency: z.string().trim().length(3).optional(),
  iban: nullableText(64),
  e_invoice_address: nullableText(300),
  e_invoice_operator: nullableText(300),
  e_invoice_ovt: nullableText(64),
  delivery_method: z.enum(['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER']).optional(),
  reminder_fee_amount: nullableText(28),
  late_interest_enabled: z.boolean().optional(),
  late_interest_rate: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid decimal').optional(),
  late_interest_grace_days: z.number().int().min(0).max(3650).optional(),
  ...registryFields,
});

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: decimalString,
  unit: z.string().trim().max(40).optional(),
  unit_price: decimalString,
  discount_percent: decimalString.optional(),
  tax_code_id: uuidString,
  revenue_account_id: uuidString.nullable().optional(),
});

const invoiceDraftSchema = z.object({
  customer_id: uuidString,
  series_id: uuidString.optional(),
  issue_date: dateString.optional(),
  due_date: dateString.optional(),
  currency_code: z.string().trim().length(3).optional(),
  language: z.string().trim().length(2).optional(),
  reference_type: z.enum(['FI_DOMESTIC', 'RF', 'NONE']).optional(),
  document_type: z.enum(['SALES_INVOICE', 'ADVANCE_INVOICE']).optional(),
  discount_percent: decimalString.optional(),
  discount_amount: decimalString.optional(),
  delivery_method: z.enum(['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER']).optional(),
  customer_po_number: nullableText(100),
  customer_reference: nullableText(200),
  lines: z.array(invoiceLineSchema).min(1).max(200),
});

const seriesSchema = z.object({
  name: z.string().trim().min(1).max(100),
  prefix: z.string().trim().max(40).optional(),
  fiscal_year_id: uuidString.nullable().optional(),
  is_active: z.boolean().optional(),
});

const settingsSchema = z.object({
  default_invoice_series_id: uuidString.nullable().optional(),
  default_payment_terms_days: z.number().int().min(0).max(3650).optional(),
  accounts_receivable_account_id: uuidString.nullable().optional(),
  default_sales_revenue_account_id: uuidString.nullable().optional(),
  tax_payable_account_id: uuidString.nullable().optional(),
  default_language: z.string().trim().length(2).optional(),
  default_currency: z.string().trim().length(3).optional(),
  payment_reference_type: z.enum(['FI_DOMESTIC', 'RF', 'NONE']).optional(),
  bank_iban: nullableText(64),
  bank_bic: nullableText(32),
  bank_account_holder: nullableText(200),
  advance_payments_received_account_id: uuidString.nullable().optional(),
  default_delivery_method: z.enum(['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER']).optional(),
  reminder_fee_enabled: z.boolean().optional(),
  reminder_fee_amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid decimal').optional(),
  late_interest_enabled: z.boolean().optional(),
  late_interest_rate: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid decimal').optional(),
  late_interest_grace_days: z.number().int().min(0).max(3650).optional(),
});

interface SalesRouteOptions {
  db: Db;
  config: AppConfig;
  storage: LocalObjectStorageProvider;
  emailProvider: EmailProvider;
}

async function context(request: FastifyRequest, db: Db, config: AppConfig) {
  const { user } = await resolveSessionUser(db, request, config);
  const value = request.headers['x-tilivo-tenant-id'];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id required', 400);
  }
  const tenantId = value.toLowerCase();
  await resolveTenantAccess(db, user.id, tenantId);
  return { userId: user.id, tenantId };
}

function parseLimitOffset(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

function uuidParam(value: string): string {
  const lower = value.toLowerCase();
  if (!UUID_RE.test(lower)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid id parameter', 400);
  return lower;
}

export async function salesRoutes(app: FastifyInstance, options: SalesRouteOptions): Promise<void> {
  const { db, config, storage } = options;

  // --- customers ------------------------------------------------------------
  app.get('/api/v1/customers', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    const active = query.active === undefined ? undefined : query.active === 'true';
    const { limit, offset } = parseLimitOffset(query);
    const result = await listCustomers(db, tenantId, {
      search: typeof query.search === 'string' ? query.search : undefined,
      active,
      limit,
      offset,
    });
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/customers', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.customer.manage');
    const parsed = customerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidCustomer, 'Invalid customer payload', 400, parsed.error.flatten());
    }
    const customer = await createCustomer(db, tenantId, userId, parsed.data);
    await writeAuditEvent(db, 'CUSTOMER.CREATED', request, {
      userId,
      tenantId,
      objectType: 'business_party',
      objectId: String(customer.id),
      metadata: { customer_id: String(customer.id), name: String(customer.name) },
    });
    if (parsed.data.registry_source_id) {
      await writeAuditEvent(db, 'CUSTOMER.REGISTRY_IMPORTED', request, {
        userId,
        tenantId,
        objectType: 'business_party',
        objectId: String(customer.id),
        metadata: {
          customer_id: String(customer.id),
          registry_source: String(parsed.data.registry_source ?? ''),
          registry_source_id: parsed.data.registry_source_id,
        },
      });
    }
    return reply.code(201).send({ customer });
  });

  app.get<{ Params: { id: string } }>('/api/v1/customers/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const customer = await getCustomer(db, tenantId, uuidParam(request.params.id));
    return { customer };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/customers/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.customer.manage');
      const parsed = customerSchema.partial().safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.invalidCustomer, 'Invalid customer payload', 400, parsed.error.flatten());
      }
      const customer = await updateCustomer(db, tenantId, uuidParam(request.params.id), parsed.data);
      await writeAuditEvent(db, 'CUSTOMER.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'business_party',
        objectId: String(customer.id),
        metadata: { customer_id: String(customer.id) },
      });
      if (parsed.data.registry_source_id) {
        await writeAuditEvent(db, 'CUSTOMER.REGISTRY_REFRESHED', request, {
          userId,
          tenantId,
          objectType: 'business_party',
          objectId: String(customer.id),
          metadata: {
            customer_id: String(customer.id),
            registry_source: String(parsed.data.registry_source ?? ''),
            registry_source_id: parsed.data.registry_source_id,
          },
        });
      }
      return { customer };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/customers/:id/deactivate',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.customer.manage');
      const customer = await setCustomerActive(db, tenantId, uuidParam(request.params.id), false);
      await writeAuditEvent(db, 'CUSTOMER.DEACTIVATED', request, {
        userId,
        tenantId,
        objectType: 'business_party',
        objectId: String(customer.id),
        metadata: { customer_id: String(customer.id), name: String(customer.name) },
      });
      return { customer };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/customers/:id/activate', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.customer.manage');
    const customer = await setCustomerActive(db, tenantId, uuidParam(request.params.id), true);
    await writeAuditEvent(db, 'CUSTOMER.ACTIVATED', request, {
      userId,
      tenantId,
      objectType: 'business_party',
      objectId: String(customer.id),
      metadata: { customer_id: String(customer.id) },
    });
    return { customer };
  });

  // --- series ---------------------------------------------------------------
  app.get('/api/v1/sales/series', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const series = await listSeries(db, tenantId);
    return { series };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/sales/series', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.settings.manage');
    const parsed = seriesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.numberSeriesNotFound, 'Invalid series payload', 400, parsed.error.flatten());
    }
    const series = await createSeries(db, tenantId, parsed.data);
    await writeAuditEvent(db, 'SALES_SERIES.CREATED', request, {
      userId,
      tenantId,
      objectType: 'invoice_number_series',
      objectId: String(series.id),
      metadata: { name: String(series.name), prefix: String(series.prefix ?? '') },
    });
    return reply.code(201).send({ series });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/series/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.settings.manage');
      const parsed = seriesSchema.partial().safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.numberSeriesNotFound, 'Invalid series payload', 400, parsed.error.flatten());
      }
      const series = await updateSeries(db, tenantId, uuidParam(request.params.id), parsed.data);
      await writeAuditEvent(db, 'SALES_SERIES.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'invoice_number_series',
        objectId: String(series.id),
        metadata: { name: String(series.name) },
      });
      return { series };
    },
  );

  // --- settings ---------------------------------------------------------------
  app.get('/api/v1/sales/settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const settings = await getSalesSettings(db, tenantId);
    return { settings };
  });

  app.patch<{ Body: Record<string, unknown> }>('/api/v1/sales/settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.settings.manage');
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid sales settings payload', 400, parsed.error.flatten());
    }
    const settings = await updateSalesSettings(db, tenantId, parsed.data);
    await writeAuditEvent(db, 'SALES_SETTINGS.UPDATED', request, {
      userId,
      tenantId,
      objectType: 'sales_settings',
      objectId: String(settings.id),
      metadata: { tenant_id: tenantId },
    });
    return { settings };
  });

  // --- invoices ----------------------------------------------------------------
  app.get('/api/v1/sales/invoices', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    const { limit, offset } = parseLimitOffset(query);
    const status = typeof query.status === 'string' ? query.status.toUpperCase() : undefined;
    if (status && !['DRAFT', 'ISSUED', 'CREDITED', 'CANCELLED_DRAFT'].includes(status)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid invoice status filter', 400);
    }
    const from = typeof query.from === 'string' ? query.from : undefined;
    const to = typeof query.to === 'string' ? query.to : undefined;
    if (from && !DATE_RE.test(from)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid from date', 400);
    if (to && !DATE_RE.test(to)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid to date', 400);
    const result = await listInvoices(db, tenantId, {
      status: status as any,
      customerId: typeof query.customer_id === 'string' ? query.customer_id : undefined,
      from,
      to,
      search: typeof query.search === 'string' ? query.search : undefined,
      limit,
      offset,
    });
    return result;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/sales/invoices', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'invoice.create');
    const parsed = invoiceDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidInvoiceLine, 'Invalid invoice payload', 400, parsed.error.flatten());
    }
    const invoice = await createInvoiceDraft(db, tenantId, userId, parsed.data);
    await writeAuditEvent(db, 'SALES_INVOICE.DRAFT_CREATED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: String(invoice.id),
      metadata: { invoice_id: String(invoice.id), customer_id: String(invoice.customer_id) },
    });
    return reply.code(201).send({ invoice });
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const invoice = await getInvoice(db, tenantId, uuidParam(request.params.id));
    return { invoice };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/invoices/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'invoice.create');
      const parsed = invoiceDraftSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.invalidInvoiceLine, 'Invalid invoice payload', 400, parsed.error.flatten());
      }
      const invoice = await updateInvoiceDraft(db, tenantId, uuidParam(request.params.id), parsed.data);
      await writeAuditEvent(db, 'SALES_INVOICE.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: String(invoice.id),
        metadata: { invoice_id: String(invoice.id) },
      });
      return { invoice };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/invoices/:id/issue',
    async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'invoice.issue');
    const invoiceId = uuidParam(request.params.id);
    const body = request.body ?? {};
    const advanceAllocations = Array.isArray(body.advance_allocations)
      ? (body.advance_allocations as Array<{ advance_invoice_id: string; amount: string }>).map((item) => ({
          advanceInvoiceId: String(item.advance_invoice_id),
          amount: String(item.amount),
        }))
      : undefined;
    const result = await issueInvoice(db, tenantId, invoiceId, userId, { advanceAllocations });
    const issued = result.invoice;
    await writeAuditEvent(db, 'SALES_INVOICE.ISSUED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: {
        invoice_id: invoiceId,
        invoice_number: String(issued.invoice_number),
        customer_id: String(issued.customer_id),
        issue_date: String(issued.issue_date),
        due_date: String(issued.due_date),
        currency: String(issued.currency_code),
        subtotal: String(issued.subtotal),
        tax_total: String(issued.tax_total),
        total: String(issued.total),
        journal_entry_id: String(issued.accounting_journal_entry_id),
        document_type: String(issued.document_type ?? 'SALES_INVOICE'),
        advance_applied: String(issued.advance_applied ?? '0'),
      },
    });
    if (String(issued.document_type ?? '') === 'ADVANCE_INVOICE') {
      await writeAuditEvent(db, 'SALES_ADVANCE.ISSUED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: invoiceId,
        metadata: { invoice_id: invoiceId, invoice_number: String(issued.invoice_number) },
      });
    }
    if (advanceAllocations && advanceAllocations.length > 0) {
      await writeAuditEvent(db, 'SALES_ADVANCE.APPLIED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: invoiceId,
        metadata: {
          invoice_id: invoiceId,
          invoice_number: String(issued.invoice_number),
          advance_allocations: advanceAllocations.map((item) => ({
            advance_invoice_id: item.advanceInvoiceId,
            amount: item.amount,
          })),
        },
      });
    }
    return { invoice: issued, journal_entry_id: result.entryId };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/invoices/:id/credit',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'invoice.credit');
      const originalId = uuidParam(request.params.id);
      const body = request.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const result = await creditInvoice(db, tenantId, originalId, userId, reason);
      const creditInvoiceRow = result.credit_invoice;
      await writeAuditEvent(db, 'SALES_INVOICE.CREDIT_CREATED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: String(creditInvoiceRow.id),
        metadata: { original_invoice_id: originalId, credit_invoice_id: String(creditInvoiceRow.id) },
      });
      await writeAuditEvent(db, 'SALES_INVOICE.CREDIT_ISSUED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: String(creditInvoiceRow.id),
        metadata: {
          original_invoice_id: originalId,
          credit_invoice_id: String(creditInvoiceRow.id),
          credit_invoice_number: String(creditInvoiceRow.invoice_number),
          journal_entry_id: String(creditInvoiceRow.accounting_journal_entry_id),
        },
      });
      return { original_invoice: result.original_invoice, credit_invoice: creditInvoiceRow };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/cancel-draft', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'invoice.create');
    const invoiceId = uuidParam(request.params.id);
    const invoice = await cancelInvoiceDraft(db, tenantId, invoiceId);
    await writeAuditEvent(db, 'SALES_INVOICE.DRAFT_CANCELLED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId },
    });
    return { invoice };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/pdf', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const invoiceId = uuidParam(request.params.id);
    const pdf = await getInvoicePdfMetadata(db, tenantId, invoiceId);
    if (!pdf.document_id) throw new AppError(ErrorCodes.pdfNotReady, 'Invoice PDF is not available', 404);
    const download = await getDocumentDownload(db, tenantId, String(pdf.document_id));
    const data = await storage.get(download.storageKey);
    const safeName = String(pdf.invoice_number ?? invoiceId).replace(/[^A-Za-z0-9._-]/g, '_');
    reply.header('content-type', 'application/pdf');
    reply.header('content-length', String(data.length));
    reply.header('content-disposition', `attachment; filename="invoice-${safeName}.pdf"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(data);
  });

  app.post<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/pdf/retry', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'invoice.pdf.retry');
    const invoiceId = uuidParam(request.params.id);
    const pdf = await retryInvoicePdf(db, tenantId, invoiceId);
    await writeAuditEvent(db, 'SALES_INVOICE.PDF_RETRY_REQUESTED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId, pdf_status: String(pdf.status) },
    });
    return { pdf };
  });

  app.get('/api/v1/sales/ledger', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    const result = await salesLedger(db, tenantId, {
      status: typeof query.status === 'string' ? query.status.toUpperCase() : undefined,
      documentType: typeof query.document_type === 'string' ? query.document_type.toUpperCase() : undefined,
      unpaid: query.unpaid === 'true',
      overdue: query.overdue === 'true',
      search: typeof query.search === 'string' ? query.search : undefined,
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
      limit: Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500),
      offset: Math.max(Number(query.offset ?? 0) || 0, 0),
    });
    return result;
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v1/sales/invoices/:id/payments', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.payment.record');
    const invoiceId = uuidParam(request.params.id);
    const body = request.body ?? {};
    const amount = typeof body.amount === 'string' ? body.amount : '';
    const paymentDate = typeof body.payment_date === 'string' ? body.payment_date : '';
    if (!amount || !paymentDate) throw new AppError(ErrorCodes.invalidRequest, 'Amount and payment date are required', 400);
    const result = await recordSalesPayment(db, tenantId, invoiceId, userId, {
      amount,
      paymentDate,
      method: typeof body.method === 'string' ? body.method : 'MANUAL',
      reference: typeof body.reference === 'string' ? body.reference : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    await writeAuditEvent(db, 'SALES_PAYMENT.RECORDED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId, amount, status: result.status },
    });
    return { payment: result.payment, payment_status: result.status, amount_paid: result.amount_paid };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v1/sales/invoices/:id/reminders', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.reminder.create');
    const invoiceId = uuidParam(request.params.id);
    const body = request.body ?? {};
    const result = await createSalesReminder(db, tenantId, invoiceId, userId, {
      note: typeof body.note === 'string' ? body.note : undefined,
      level: typeof body.level === 'number' ? body.level : undefined,
      applyReminderFee: typeof body.apply_reminder_fee === 'boolean' ? body.apply_reminder_fee : false,
    });
    await writeAuditEvent(db, 'SALES_REMINDER.CREATED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId, reminder_id: String(result.reminder.id) },
    });
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/reminders', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const reminders = await listSalesReminders(db, tenantId, uuidParam(request.params.id));
    return { reminders };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/payments', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const payments = await listSalesPayments(db, tenantId, uuidParam(request.params.id));
    return { payments };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/advances', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const state = await getInvoiceAdvanceState(db, tenantId, uuidParam(request.params.id));
    return { advance_state: state };
  });

  app.get('/api/v1/sales/recurring-templates', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const templates = await listRecurringTemplates(db, tenantId);
    return { templates };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/sales/recurring-templates', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
    const body = request.body ?? {};
    const template = await createRecurringTemplate(db, tenantId, userId, {
      customerId: String(body.customer_id),
      name: String(body.name),
      frequency: String(body.frequency ?? 'MONTHLY'),
      startDate: String(body.start_date),
      endDate: typeof body.end_date === 'string' ? body.end_date : undefined,
      language: typeof body.language === 'string' ? body.language : 'fi',
      paymentTermsDays: typeof body.payment_terms_days === 'number' ? body.payment_terms_days : 14,
      lines: Array.isArray(body.lines) ? (body.lines as any[]) : [],
    });
    await writeAuditEvent(db, 'RECURRING_TEMPLATE.CREATED', request, {
      userId,
      tenantId,
      objectType: 'recurring_template',
      objectId: String(template.id),
      metadata: { template_id: String(template.id), name: String(template.name) },
    });
    return reply.code(201).send({ template });
  });

  app.post('/api/v1/sales/recurring-templates/generate', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
    const generated = await generateDueRecurringInvoices(db, tenantId, userId);
    await writeAuditEvent(db, 'RECURRING_INVOICE.GENERATED', request, {
      userId,
      tenantId,
      objectType: 'recurring_template',
      metadata: { count: generated.length },
    });
    return { generated };
  });

  // --- credit notes (full + partial) -------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/creditable', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    return { creditable: await getCreditableSummary(db, tenantId, uuidParam(request.params.id)) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/credit-notes', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const notes = await listCreditNotes(db, tenantId, uuidParam(request.params.id));
    return { credit_notes: notes };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/invoices/:id/credit-note',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'invoice.credit');
      const originalId = uuidParam(request.params.id);
      const body = request.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const lines = Array.isArray(body.lines)
        ? (body.lines as Array<{ sales_invoice_line_id: string; quantity?: string; unit_price?: string }>)
        : undefined;
      const result = await createCreditNote(db, tenantId, originalId, userId, { reason, lines });
      const creditRow = result.credit_invoice;
      await writeAuditEvent(db, 'SALES_INVOICE.CREDIT_CREATED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: String(creditRow.id),
        metadata: { original_invoice_id: originalId, credit_invoice_id: String(creditRow.id) },
      });
      await writeAuditEvent(db, 'SALES_INVOICE.CREDIT_ISSUED', request, {
        userId,
        tenantId,
        objectType: 'sales_invoice',
        objectId: String(creditRow.id),
        metadata: {
          original_invoice_id: originalId,
          credit_invoice_id: String(creditRow.id),
          credit_invoice_number: String(creditRow.invoice_number),
          journal_entry_id: String(creditRow.accounting_journal_entry_id),
        },
      });
      if (result.partial) {
        await writeAuditEvent(db, 'SALES_INVOICE.PARTIALLY_CREDITED', request, {
          userId,
          tenantId,
          objectType: 'sales_invoice',
          objectId: originalId,
          metadata: { original_invoice_id: originalId, credit_invoice_id: String(creditRow.id) },
        });
      }
      return reply.code(201).send(result);
    },
  );

  // --- AR aging / statements / balances ------------------------------------
  app.get('/api/v1/sales/aging', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    return salesAging(db, tenantId, {
      asOf: typeof query.as_of === 'string' ? query.as_of : undefined,
      customerId: typeof query.customer_id === 'string' ? query.customer_id : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/customers/:id/statement', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    const statement = await customerStatement(db, tenantId, uuidParam(request.params.id), {
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
    });
    return { statement };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/customers/:id/balance', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const balance = await customerBalance(db, tenantId, uuidParam(request.params.id));
    return { balance };
  });

  // --- delivery --------------------------------------------------------------
  app.get('/api/v1/sales/send-history', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const query = request.query as Record<string, unknown>;
    const history = await listSendHistory(db, tenantId, {
      documentType: typeof query.document_type === 'string' ? query.document_type : undefined,
      documentId: typeof query.document_id === 'string' ? query.document_id : undefined,
    });
    return { history };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/invoices/:id/send',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.invoice.send');
      const invoiceId = uuidParam(request.params.id);
      const body = request.body ?? {};
      const recipient = typeof body.recipient === 'string' && body.recipient
        ? String(body.recipient)
        : undefined;
      const message = typeof body.message === 'string' ? String(body.message) : undefined;
      const invoice = await getInvoice(db, tenantId, invoiceId);
      if (!['ISSUED', 'PARTIALLY_PAID', 'CREDITED'].includes(String(invoice.status))) {
        throw new AppError(ErrorCodes.invoiceNotDraft, 'Only issued invoices can be sent', 409);
      }
      const pdfMeta = await getInvoicePdfMetadata(db, tenantId, invoiceId);
      const download = await getDocumentDownload(db, tenantId, String(pdfMeta.document_id));
      const data = await storage.get(download.storageKey);
      const to = recipient ?? String((invoice.customer_snapshot as any)?.email ?? '');
      const number = String(invoice.invoice_number ?? invoiceId);
      const subject = `Invoice ${number}`;
      const text = message ?? `Please find attached invoice ${number}.`;
      try {
        await options.emailProvider.send({
          to,
          subject,
          text,
          attachments: [{ filename: `invoice-${number}.pdf`, contentType: 'application/pdf', content: data }],
        });
        await appendSendHistory(db, tenantId, userId, {
          documentType: 'SALES_INVOICE',
          documentId: invoiceId,
          channel: 'EMAIL',
          recipient: to,
          subject,
          provider: options.emailProvider.kind,
          status: 'SENT',
        });
        await setInvoiceDeliveryState(db, tenantId, invoiceId, 'SENT');
        await writeAuditEvent(db, 'SALES_INVOICE.SENT', request, {
          userId,
          tenantId,
          objectType: 'sales_invoice',
          objectId: invoiceId,
          metadata: { invoice_id: invoiceId, recipient: to, channel: 'EMAIL' },
        });
        return { sent: true, status: 'SENT', recipient: to };
      } catch (cause) {
        const errorMessage = cause instanceof Error ? cause.message.slice(0, 400) : 'Email provider failure';
        await appendSendHistory(db, tenantId, userId, {
          documentType: 'SALES_INVOICE',
          documentId: invoiceId,
          channel: 'EMAIL',
          recipient: to,
          subject,
          provider: options.emailProvider.kind,
          status: 'FAILED',
          error: errorMessage,
        });
        await setInvoiceDeliveryState(db, tenantId, invoiceId, 'FAILED');
        return { sent: false, status: 'FAILED', error: errorMessage };
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/e-invoice/export', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.einvoice.export');
    const invoiceId = uuidParam(request.params.id);
    const result = await exportEInvoicePayload(db, tenantId, invoiceId, userId);
    await writeAuditEvent(db, 'SALES_INVOICE.EINVOICE_EXPORTED', request, {
      userId,
      tenantId,
      objectType: 'sales_invoice',
      objectId: invoiceId,
      metadata: { invoice_id: invoiceId },
    });
    return reply.send(result);
  });

  // --- reminders: detail, PDF and send --------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/sales/reminders/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    return { reminder: await getSalesReminder(db, tenantId, uuidParam(request.params.id)) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/sales/reminders/:id/pdf', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const reminderId = uuidParam(request.params.id);
    const reminder = await requestReminderPdf(db, tenantId, reminderId);
    await writeAuditEvent(db, 'SALES_REMINDER.PDF_REQUESTED', request, {
      userId,
      tenantId,
      objectType: 'sales_reminder',
      objectId: reminderId,
      metadata: { reminder_id: reminderId },
    });
    return { reminder };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sales/reminders/:id/pdf', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const reminderId = uuidParam(request.params.id);
    const pdf = await getReminderPdfMetadata(db, tenantId, reminderId);
    const download = await getDocumentDownload(db, tenantId, String(pdf.pdf_document_id));
    const data = await storage.get(download.storageKey);
    const safeName = String(pdf.reminder_number ?? reminderId).replace(/[^A-Za-z0-9._-]/g, '_');
    reply.header('content-type', 'application/pdf');
    reply.header('content-length', String(data.length));
    reply.header('content-disposition', `attachment; filename="${safeName}.pdf"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(data);
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/reminders/:id/send',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.invoice.send');
      const reminderId = uuidParam(request.params.id);
      const body = request.body ?? {};
      const reminder = await getSalesReminder(db, tenantId, reminderId);
      const invoiceId = String(reminder.invoice_id);
      const invoice = await getInvoice(db, tenantId, invoiceId);
      if (reminder.pdf_status !== 'READY' || !reminder.pdf_document_id) {
        throw new AppError(ErrorCodes.pdfNotReady, 'Generate the reminder PDF before sending', 409);
      }
      const download = await getDocumentDownload(db, tenantId, String(reminder.pdf_document_id));
      const data = await storage.get(download.storageKey);
      const to = typeof body.recipient === 'string' && body.recipient
        ? String(body.recipient)
        : String(reminder.recipient ?? (invoice.customer_snapshot as any)?.email ?? '');
      const subject = typeof body.subject === 'string' && body.subject
        ? String(body.subject)
        : `Reminder ${String(reminder.reminder_number ?? reminderId)}`;
      const text = typeof body.message === 'string' && body.message
        ? String(body.message)
        : `Invoice ${String(invoice.invoice_number ?? invoiceId)} is overdue.`;
      try {
        await options.emailProvider.send({
          to,
          subject,
          text,
          attachments: [{
            filename: `${String(reminder.reminder_number ?? 'reminder')}.pdf`,
            contentType: 'application/pdf',
            content: data,
          }],
        });
        await markReminderSendResult(db, tenantId, reminderId, { status: 'SENT', sentVia: 'email' });
        await appendSendHistory(db, tenantId, userId, {
          documentType: 'SALES_REMINDER',
          documentId: reminderId,
          channel: 'EMAIL',
          recipient: to,
          subject,
          provider: options.emailProvider.kind,
          status: 'SENT',
        });
        await writeAuditEvent(db, 'SALES_REMINDER.SENT', request, {
          userId,
          tenantId,
          objectType: 'sales_reminder',
          objectId: reminderId,
          metadata: { reminder_id: reminderId, recipient: to },
        });
        return { sent: true, status: 'SENT', recipient: to };
      } catch (cause) {
        const errorMessage = cause instanceof Error ? cause.message.slice(0, 400) : 'Email provider failure';
        await markReminderSendResult(db, tenantId, reminderId, {
          status: 'FAILED',
          sentVia: 'email',
          error: errorMessage,
        });
        await appendSendHistory(db, tenantId, userId, {
          documentType: 'SALES_REMINDER',
          documentId: reminderId,
          channel: 'EMAIL',
          recipient: to,
          subject,
          provider: options.emailProvider.kind,
          status: 'FAILED',
          error: errorMessage,
        });
        return { sent: false, status: 'FAILED', error: errorMessage };
      }
    },
  );

  // --- recurring templates management ---------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/sales/recurring-templates/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.read');
    const template = await getRecurringTemplate(db, tenantId, uuidParam(request.params.id));
    return { template };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/sales/recurring-templates/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
      const templateId = uuidParam(request.params.id);
      const body = request.body ?? {};
      const template = await updateRecurringTemplate(db, tenantId, templateId, userId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        frequency: typeof body.frequency === 'string' ? body.frequency : undefined,
        endDate: body.end_date === null ? null : typeof body.end_date === 'string' ? body.end_date : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        paymentTermsDays: typeof body.payment_terms_days === 'number' ? body.payment_terms_days : undefined,
        lines: Array.isArray(body.lines) ? (body.lines as any[]) : undefined,
      });
      await writeAuditEvent(db, 'RECURRING_TEMPLATE.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'recurring_template',
        objectId: templateId,
        metadata: { template_id: templateId },
      });
      return { template };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/sales/recurring-templates/:id/disable', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
    const template = await setRecurringTemplateActive(db, tenantId, uuidParam(request.params.id), false);
    return { template };
  });

  app.post<{ Params: { id: string } }>('/api/v1/sales/recurring-templates/:id/activate', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
    const template = await setRecurringTemplateActive(db, tenantId, uuidParam(request.params.id), true);
    return { template };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/sales/recurring-templates/:id', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'sales.recurring.manage');
    const templateId = uuidParam(request.params.id);
    await deleteRecurringTemplate(db, tenantId, templateId);
    return reply.code(204).send();
  });
}
