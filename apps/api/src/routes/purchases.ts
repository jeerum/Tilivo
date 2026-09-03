import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import type { LocalObjectStorageProvider } from '../services/documentStorage';
import {
  approvePurchaseInvoice,
  attachPurchaseDocument,
  cancelPurchaseDraft,
  correctPurchaseInvoice,
  createPurchaseInvoiceDraft,
  createSupplier,
  getPurchase,
  getPurchaseSettings,
  getSupplier,
  importEinvoice,
  listPurchaseDocuments,
  listPurchaseImports,
  listPurchases,
  listSuppliers,
  postPurchaseInvoice,
  rejectPurchaseInvoice,
  reviewPurchaseInvoice,
  runPurchaseOcr,
  setSupplierActive,
  updatePurchaseInvoiceDraft,
  updatePurchaseSettings,
  updateSupplier,
} from '../services/purchaseService';
import { createDocumentOcrProvider } from '../services/ocrService';
import {
  applyClassification,
  classifyPurchaseDocument,
  createExpenseClassificationProvider,
  getLatestClassification,
} from '../services/expenseClassificationService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess, withTenantTransaction } from '../services/tenantService';
import { writeAuditEvent } from '../services/audit';
import { registryCompanySchema } from '../services/businessRegistryTypes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const decimalString = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'Invalid decimal'),
);

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(300),
  business_id: z.string().trim().max(64).nullable().optional(),
  vat_id: z.string().trim().max(64).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(64).nullable().optional(),
  address_line1: z.string().trim().max(300).nullable().optional(),
  address_line2: z.string().trim().max(300).nullable().optional(),
  postal_code: z.string().trim().max(32).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  country_code: z.string().trim().length(2).optional(),
  language: z.string().trim().length(2).optional(),
  payment_terms_days: z.number().int().min(0).max(3650).optional(),
  default_currency: z.string().trim().length(3).optional(),
  iban: z.string().trim().max(64).nullable().optional(),
  e_invoice_address: z.string().trim().max(300).nullable().optional(),
  e_invoice_operator: z.string().trim().max(300).nullable().optional(),
  default_expense_account_id: z.string().regex(UUID_RE).nullable().optional(),
  default_tax_code_id: z.string().regex(UUID_RE).nullable().optional(),
  registry_source: z.string().trim().max(64).nullable().optional(),
  registry_source_id: z.string().trim().max(64).nullable().optional(),
  registry_fetched_at: z.string().datetime({ offset: true }).nullable().optional(),
  registry_snapshot: registryCompanySchema.nullable().optional(),
});

const purchaseLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: decimalString.nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  unit_price: decimalString.nullable().optional(),
  net_amount: decimalString.nullable().optional(),
  tax_code_id: z.string().regex(UUID_RE),
  tax_type: z.string().trim().max(40).nullable().optional(),
  deductible_percent: decimalString.nullable().optional(),
  expense_account_id: z.string().regex(UUID_RE).nullable().optional(),
  cost_center: z.string().trim().max(120).nullable().optional(),
});

const purchaseDraftSchema = z.object({
  supplier_id: z.string().regex(UUID_RE).nullable().optional(),
  merchant_name: z.string().trim().max(300).nullable().optional(),
  supplier_invoice_number: z.string().trim().max(100).optional(),
  invoice_date: z.string().regex(DATE_RE),
  due_date: z.string().regex(DATE_RE).optional(),
  currency_code: z.string().trim().length(3).optional(),
  supplier_reference: z.string().trim().max(200).optional(),
  supplier_iban: z.string().trim().max(64).nullable().optional(),
  document_type: z
    .enum(['PURCHASE_INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'CASH_EXPENSE', 'CARD_EXPENSE'])
    .optional(),
  payment_method: z
    .enum(['BANK_TRANSFER', 'COMPANY_CARD', 'CASH', 'PERSONAL_CARD', 'EMPLOYEE_PAID', 'OTHER'])
    .optional(),
  payment_status: z.enum(['UNPAID', 'PAID', 'PARTIALLY_PAID', 'PAID_AT_PURCHASE']).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(purchaseLineSchema).min(1).max(200),
});

const settingsSchema = z.object({
  accounts_payable_account_id: z.string().regex(UUID_RE).nullable().optional(),
  default_expense_account_id: z.string().regex(UUID_RE).nullable().optional(),
  input_vat_account_id: z.string().regex(UUID_RE).nullable().optional(),
  reverse_charge_input_account_id: z.string().regex(UUID_RE).nullable().optional(),
  reverse_charge_output_account_id: z.string().regex(UUID_RE).nullable().optional(),
  cash_account_id: z.string().regex(UUID_RE).nullable().optional(),
  company_card_account_id: z.string().regex(UUID_RE).nullable().optional(),
  employee_payable_account_id: z.string().regex(UUID_RE).nullable().optional(),
  require_separate_approver: z.boolean().optional(),
  auto_post_on_approval: z.boolean().optional(),
  default_currency: z.string().trim().length(3).optional(),
});

interface PurchaseRouteOptions {
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

function idParam(value: string): string {
  const lower = value.toLowerCase();
  if (!UUID_RE.test(lower)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid id parameter', 400);
  return lower;
}

function parsePaging(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500),
    offset: Math.max(Number(query.offset ?? 0) || 0, 0),
  };
}

export async function purchaseRoutes(app: FastifyInstance, options: PurchaseRouteOptions): Promise<void> {
  const { db, config, storage } = options;

  // Suppliers ---------------------------------------------------------------
  app.get('/api/v1/suppliers', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const query = request.query as Record<string, unknown>;
    const active = query.active === undefined ? undefined : query.active === 'true';
    const paging = parsePaging(query);
    return listSuppliers(db, tenantId, {
      search: typeof query.search === 'string' ? query.search : undefined,
      active,
      ...paging,
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/suppliers', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'supplier.manage');
    const parsed = supplierSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidCustomer, 'Invalid supplier payload', 400, parsed.error.flatten());
    }
    const supplier = await createSupplier(db, tenantId, userId, parsed.data);
    await writeAuditEvent(db, 'SUPPLIER.CREATED', request, {
      userId,
      tenantId,
      objectType: 'business_party',
      objectId: String(supplier.id),
      metadata: { supplier_id: String(supplier.id), name: String(supplier.name) },
    });
    if (parsed.data.registry_source_id) {
      await writeAuditEvent(db, 'SUPPLIER.REGISTRY_IMPORTED', request, {
        userId,
        tenantId,
        objectType: 'business_party',
        objectId: String(supplier.id),
        metadata: {
          supplier_id: String(supplier.id),
          registry_source: String(parsed.data.registry_source ?? ''),
          registry_source_id: parsed.data.registry_source_id,
        },
      });
    }
    return reply.code(201).send({ supplier });
  });

  app.get<{ Params: { id: string } }>('/api/v1/suppliers/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const supplier = await getSupplier(db, tenantId, idParam(request.params.id));
    return { supplier };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/suppliers/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'supplier.manage');
      const parsed = supplierSchema.partial().safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.invalidCustomer, 'Invalid supplier payload', 400, parsed.error.flatten());
      }
      const supplier = await updateSupplier(db, tenantId, idParam(request.params.id), parsed.data);
      await writeAuditEvent(db, 'SUPPLIER.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'business_party',
        objectId: String(supplier.id),
        metadata: { supplier_id: String(supplier.id) },
      });
      if (parsed.data.registry_source_id) {
        await writeAuditEvent(db, 'SUPPLIER.REGISTRY_REFRESHED', request, {
          userId,
          tenantId,
          objectType: 'business_party',
          objectId: String(supplier.id),
          metadata: {
            supplier_id: String(supplier.id),
            registry_source: String(parsed.data.registry_source ?? ''),
            registry_source_id: parsed.data.registry_source_id,
          },
        });
      }
      return { supplier };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/suppliers/:id/deactivate', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'supplier.manage');
    const supplier = await setSupplierActive(db, tenantId, idParam(request.params.id), false);
    await writeAuditEvent(db, 'SUPPLIER.DEACTIVATED', request, {
      userId,
      tenantId,
      objectType: 'business_party',
      objectId: String(supplier.id),
      metadata: { supplier_id: String(supplier.id) },
    });
    return { supplier };
  });

  app.post<{ Params: { id: string } }>('/api/v1/suppliers/:id/activate', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'supplier.manage');
    const supplier = await setSupplierActive(db, tenantId, idParam(request.params.id), true);
    await writeAuditEvent(db, 'SUPPLIER.ACTIVATED', request, {
      userId,
      tenantId,
      objectType: 'business_party',
      objectId: String(supplier.id),
      metadata: { supplier_id: String(supplier.id) },
    });
    return { supplier };
  });

  // Settings -----------------------------------------------------------------
  app.get('/api/v1/purchase-settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const settings = await getPurchaseSettings(db, tenantId);
    return { settings };
  });

  app.patch<{ Body: Record<string, unknown> }>('/api/v1/purchase-settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.settings.manage');
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid purchase settings payload', 400, parsed.error.flatten());
    }
    const settings = await updatePurchaseSettings(db, tenantId, parsed.data);
    await writeAuditEvent(db, 'PURCHASE_SETTINGS.UPDATED', request, {
      userId,
      tenantId,
      objectType: 'purchase_settings',
      objectId: String(settings.id),
      metadata: { tenant_id: tenantId },
    });
    return { settings };
  });

  // Purchases ----------------------------------------------------------------
  app.get('/api/v1/purchases', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' ? query.status.toUpperCase() : undefined;
    if (status && !['INGESTED','DRAFT','NEEDS_REVIEW','READY_FOR_APPROVAL','APPROVED','POSTED','REJECTED','CANCELLED_DRAFT','CORRECTED'].includes(status)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid purchase status filter', 400);
    }
    const paging = parsePaging(query);
    return listPurchases(db, tenantId, {
      status: status as any,
      supplierId: typeof query.supplier_id === 'string' ? query.supplier_id : undefined,
      documentType: typeof query.document_type === 'string' ? query.document_type.toUpperCase() : undefined,
      paymentMethod: typeof query.payment_method === 'string' ? query.payment_method.toUpperCase() : undefined,
      duplicateWarning: query.duplicate_warning === 'true',
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
      source: typeof query.source === 'string' ? query.source : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
      ...paging,
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/purchases', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.create');
    const parsed = purchaseDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidPurchaseLine, 'Invalid purchase payload', 400, parsed.error.flatten());
    }
    const purchase = await createPurchaseInvoiceDraft(db, tenantId, userId, parsed.data);
    await writeAuditEvent(db, 'PURCHASE.DRAFT_CREATED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: String(purchase.id),
      metadata: { purchase_invoice_id: String(purchase.id), supplier_id: String(purchase.supplier_id) },
    });
    return reply.code(201).send({ purchase });
  });

  app.get<{ Params: { id: string } }>('/api/v1/purchases/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const purchase = await getPurchase(db, tenantId, idParam(request.params.id));
    return { purchase };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/purchases/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'purchase.edit');
      const parsed = purchaseDraftSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.invalidPurchaseLine, 'Invalid purchase payload', 400, parsed.error.flatten());
      }
      const purchase = await updatePurchaseInvoiceDraft(db, tenantId, idParam(request.params.id), parsed.data);
      await writeAuditEvent(db, 'PURCHASE.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: String(purchase.id),
        metadata: { purchase_invoice_id: String(purchase.id) },
      });
      return { purchase };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/review', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.review');
    const purchaseId = idParam(request.params.id);
    const purchase = await reviewPurchaseInvoice(db, tenantId, purchaseId, userId);
    await writeAuditEvent(db, 'PURCHASE.REVIEWED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: { purchase_invoice_id: purchaseId },
    });
    return { purchase };
  });

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/approve', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.approve');
    const settings = await getPurchaseSettings(db, tenantId);
    if (settings.auto_post_on_approval) {
      await requirePermission(db, userId, tenantId, 'purchase.post');
    }
    const purchaseId = idParam(request.params.id);
    const purchase = await approvePurchaseInvoice(db, tenantId, purchaseId, userId);
    await writeAuditEvent(db, 'PURCHASE.APPROVED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: {
        purchase_invoice_id: purchaseId,
        supplier_id: purchase.supplier_id ? String(purchase.supplier_id) : null,
        supplier_invoice_number: purchase.supplier_invoice_number ?? '',
        invoice_date: String(purchase.invoice_date ?? ''),
        total: String(purchase.total),
      },
    });
    if (purchase.status === 'POSTED') {
      await writeAuditEvent(db, 'PURCHASE.POSTED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: {
          purchase_invoice_id: purchaseId,
          journal_entry_id: purchase.accounting_journal_entry_id ? String(purchase.accounting_journal_entry_id) : null,
        },
      });
    }
    return { purchase };
  });

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/post', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.post');
    const purchaseId = idParam(request.params.id);
    const purchase = await postPurchaseInvoice(db, tenantId, purchaseId, userId);
    await writeAuditEvent(db, 'PURCHASE.POSTED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: {
        purchase_invoice_id: purchaseId,
        supplier_id: purchase.supplier_id ? String(purchase.supplier_id) : null,
        supplier_invoice_number: purchase.supplier_invoice_number ?? '',
        invoice_date: String(purchase.invoice_date ?? ''),
        total: String(purchase.total),
        journal_entry_id: purchase.accounting_journal_entry_id ? String(purchase.accounting_journal_entry_id) : null,
        source_type: String(purchase.source_type),
      },
    });
    return { purchase };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/purchases/:id/reject',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'purchase.reject');
      const purchaseId = idParam(request.params.id);
      const reason = typeof request.body?.reason === 'string' ? request.body.reason : '';
      const purchase = await rejectPurchaseInvoice(db, tenantId, purchaseId, userId, reason);
      await writeAuditEvent(db, 'PURCHASE.REJECTED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: { purchase_invoice_id: purchaseId, reason },
      });
      return { purchase };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/purchases/:id/correct',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'purchase.correct');
      const purchaseId = idParam(request.params.id);
      const reason = typeof request.body?.reason === 'string' ? request.body.reason : '';
      const result = await correctPurchaseInvoice(db, tenantId, purchaseId, userId, reason);
      await writeAuditEvent(db, 'PURCHASE.CORRECTED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: {
          purchase_invoice_id: purchaseId,
          reversal_journal_entry_id: result.reversal_journal_id,
        },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/cancel-draft', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.create');
    const purchaseId = idParam(request.params.id);
    const purchase = await cancelPurchaseDraft(db, tenantId, purchaseId);
    await writeAuditEvent(db, 'PURCHASE.DRAFT_CANCELLED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: { purchase_invoice_id: purchaseId },
    });
    return { purchase };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/purchases/import', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.create');
    const body = request.body ?? {};
    const format = String(body.format ?? '').toUpperCase();
    if (!['FINVOICE', 'PEPPOL', 'TEAPPSXML'].includes(format)) {
      throw new AppError(ErrorCodes.unsupportedFormat, 'Unsupported e-invoice format', 400);
    }
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content) throw new AppError(ErrorCodes.missingRequiredField, 'XML content is required', 400);
    const result = await importEinvoice(db, tenantId, userId, {
      format: format as any,
      content,
      externalId: typeof body.external_id === 'string' ? body.external_id : undefined,
    });
    const auditAction = result.duplicate ? 'PURCHASE.DUPLICATE_DETECTED' : 'PURCHASE.INGESTED';
    await writeAuditEvent(db, auditAction, request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: String(result.purchase.id),
      metadata: {
        purchase_invoice_id: String(result.purchase.id),
        source_type: format,
        total: String(result.purchase.total ?? ''),
        duplicate: result.duplicate,
      },
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get('/api/v1/purchases/inbox', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const imports = await listPurchaseImports(db, tenantId);
    return { imports };
  });

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/ocr', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.edit');
    const purchaseId = idParam(request.params.id);
    const provider = createDocumentOcrProvider(config.OCR_DRIVER);
    const purchase = await runPurchaseOcr(db, tenantId, userId, purchaseId, provider, storage);
    await writeAuditEvent(db, 'PURCHASE.OCR_PROCESSED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: {
        purchase_invoice_id: purchaseId,
        provider: provider.name,
        ocr_status: String(purchase.ocr_status ?? ''),
        total: String(purchase.total ?? ''),
      },
    });
    return { purchase };
  });

  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/classification', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.classify');
    const purchaseId = idParam(request.params.id);
    await writeAuditEvent(db, 'PURCHASE.CLASSIFICATION_REQUESTED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: { purchase_document_id: purchaseId },
    });
    const provider = createExpenseClassificationProvider(config.EXPENSE_AI_DRIVER);
    try {
      const run = await classifyPurchaseDocument(db, tenantId, userId, purchaseId, provider);
      await writeAuditEvent(db, 'PURCHASE.CLASSIFICATION_COMPLETED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: { run_id: String(run.id), provider: provider.name, status: String(run.status) },
      });
      return { classification: run };
    } catch (error) {
      await writeAuditEvent(db, 'PURCHASE.CLASSIFICATION_FAILED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: { message: error instanceof Error ? error.message.slice(0, 300) : 'classification failed' },
      }).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/purchases/:id/classification', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const purchaseId = idParam(request.params.id);
    const run = await withTenantTransaction(db, tenantId, (client) =>
      getLatestClassification(client, tenantId, purchaseId),
    );
    return { classification: run ?? null };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/purchases/:id/classification/apply',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'purchase.classification.apply');
      const purchaseId = idParam(request.params.id);
      const body = request.body ?? {};
      const result = await applyClassification(db, tenantId, userId, purchaseId, {
        expenseAccountId: typeof body.expense_account_id === 'string' ? body.expense_account_id : undefined,
        taxCodeId: typeof body.tax_code_id === 'string' ? body.tax_code_id : undefined,
        deductibilityPercent:
          typeof body.deductibility_percent === 'string' ? body.deductibility_percent : undefined,
        paymentMethod: typeof body.payment_method === 'string' ? body.payment_method : undefined,
        costCenter: typeof body.cost_center === 'string' ? body.cost_center : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        category: typeof body.category === 'string' ? body.category : undefined,
      });
      await writeAuditEvent(db, 'PURCHASE.CLASSIFICATION_APPLIED', request, {
        userId,
        tenantId,
        objectType: 'purchase_invoice',
        objectId: purchaseId,
        metadata: { purchase_document_id: purchaseId, fields: Object.keys(body) },
      });
      return { applied: result.applied };
    },
  );

  // Documents ----------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/v1/purchases/:id/documents', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.document.upload');
    const purchaseId = idParam(request.params.id);
    const part = await request.file();
    if (!part) throw new AppError(ErrorCodes.invalidSourceDocument, 'File part is required', 400);
    const mime = part.mimetype;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) {
      throw new AppError(ErrorCodes.invalidSourceDocument, 'Only PDF, JPEG and PNG are supported', 415);
    }
    const data = await part.toBuffer();
    const result = await attachPurchaseDocument(db, tenantId, userId, purchaseId, storage, {
      originalFilename: part.filename,
      mimeType: mime as any,
      data,
    });
    await writeAuditEvent(db, 'PURCHASE.DOCUMENT_ATTACHED', request, {
      userId,
      tenantId,
      objectType: 'purchase_invoice',
      objectId: purchaseId,
      metadata: {
        purchase_invoice_id: purchaseId,
        document_id: String(result.document.id),
        sha256: String(result.document.sha256 ?? ''),
        role: result.role,
      },
    });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>('/api/v1/purchases/:id/documents', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'purchase.read');
    const documents = await listPurchaseDocuments(db, tenantId, idParam(request.params.id));
    return { documents };
  });
}
