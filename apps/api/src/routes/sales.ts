import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  cancelInvoiceDraft,
  createCustomer,
  createInvoiceDraft,
  createSeries,
  creditInvoice,
  getCustomer,
  getInvoice,
  getInvoicePdfMetadata,
  getSalesSettings,
  issueInvoice,
  listCustomers,
  listInvoices,
  listSeries,
  salesLedger,
  recordSalesPayment,
  createSalesReminder,
  listSalesReminders,
  createRecurringTemplate,
  listRecurringTemplates,
  generateDueRecurringInvoices,
  retryInvoicePdf,
  setCustomerActive,
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
});

interface SalesRouteOptions {
  db: Db;
  config: AppConfig;
  storage: LocalObjectStorageProvider;
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

  app.post<{ Params: { id: string } }>('/api/v1/sales/invoices/:id/issue', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'invoice.issue');
    const invoiceId = uuidParam(request.params.id);
    const result = await issueInvoice(db, tenantId, invoiceId, userId);
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
      },
    });
    return { invoice: issued, journal_entry_id: result.entryId };
  });

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
}
