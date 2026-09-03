import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';

export type ClassificationStatus =
  | 'NOT_REQUESTED'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED'
  | 'ACCEPTED'
  | 'PARTIALLY_ACCEPTED'
  | 'REJECTED';

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

export interface TaxCodeOption {
  id: string;
  code: string;
  rate: string;
}

export interface ClassificationRequest {
  documentType: string;
  merchant: string | null;
  supplierName: string | null;
  businessId: string | null;
  vatNumber: string | null;
  countryCode: string | null;
  date: string | null;
  currency: string | null;
  total: string | null;
  vatTotal: string | null;
  paymentMethod: string | null;
  description: string | null;
  category: string | null;
  ocrFields: Array<{ name: string; value: string; confidence: number | null }>;
  lineDescriptions: string[];
  accountOptions: AccountOption[];
  taxCodeOptions: TaxCodeOption[];
  history: Array<{ expenseAccountCode: string | null; taxCodeCode: string | null; deductiblePercent: string | null; paymentMethod: string | null }>;
}

const rawSuggestionSchema = z.object({
  expenseAccountCode: z.string().trim().max(64).optional(),
  taxCodeCode: z.string().trim().max(64).optional(),
  deductibilityPercent: z.coerce.number().min(0).max(100).optional(),
  paymentMethod: z.enum(['BANK_TRANSFER', 'COMPANY_CARD', 'CASH', 'PERSONAL_CARD', 'EMPLOYEE_PAID', 'OTHER']).optional(),
  projectCode: z.string().trim().max(120).optional(),
  costCenter: z.string().trim().max(120).optional(),
  description: z.string().trim().max(300).optional(),
  category: z.string().trim().max(40).optional(),
  overallConfidence: z.coerce.number().min(0).max(1).default(0.7),
  fieldConfidences: z
    .object({
      expenseAccount: z.coerce.number().min(0).max(1).optional(),
      taxCode: z.coerce.number().min(0).max(1).optional(),
      deductibility: z.coerce.number().min(0).max(1).optional(),
      paymentMethod: z.coerce.number().min(0).max(1).optional(),
      project: z.coerce.number().min(0).max(1).optional(),
      supplier: z.coerce.number().min(0).max(1).optional(),
    })
    .default({}),
  reasons: z
    .record(z.string().min(1).max(500))
    .default({}),
});

export interface RawClassificationSuggestion {
  expenseAccountCode?: string;
  taxCodeCode?: string;
  deductibilityPercent?: number;
  paymentMethod?: 'BANK_TRANSFER' | 'COMPANY_CARD' | 'CASH' | 'PERSONAL_CARD' | 'EMPLOYEE_PAID' | 'OTHER';
  projectCode?: string;
  costCenter?: string;
  description?: string;
  category?: string;
  overallConfidence: number;
  fieldConfidences: {
    expenseAccount?: number;
    taxCode?: number;
    deductibility?: number;
    paymentMethod?: number;
    project?: number;
    supplier?: number;
  };
  reasons: Record<string, string>;
}

export interface ExpenseClassificationProvider {
  readonly name: string;
  readonly model: string;
  classify(request: ClassificationRequest): Promise<RawClassificationSuggestion>;
}

function pickAccount(request: ClassificationRequest, needle: string): string | undefined {
  const text = `${request.merchant ?? ''} ${request.supplierName ?? ''} ${request.description ?? ''} ${request.lineDescriptions.join(' ')}`.toLowerCase();
  const candidates = request.accountOptions.filter(
    (account) => text.includes(needle) && (account.name.toLowerCase().includes(needle) || account.name.toLowerCase().includes('materials') || account.code.includes('5')),
  );
  return candidates[0]?.code ?? request.accountOptions.find((account) => /5\d{3}/.test(account.code))?.code;
}

export class MockExpenseClassificationProvider implements ExpenseClassificationProvider {
  readonly name = 'mock-ai';
  readonly model = 'deterministic-v1';

  async classify(request: ClassificationRequest): Promise<RawClassificationSuggestion> {
    const text = `${request.merchant ?? ''} ${request.supplierName ?? ''} ${request.description ?? ''} ${request.lineDescriptions.join(' ')}`.toLowerCase();
    if (text.includes('malformed')) {
      throw new Error('Malformed AI provider response (mock)');
    }
    if (text.includes('office')) {
      return {
        expenseAccountCode: request.accountOptions.find((a) => a.name.toLowerCase().includes('office'))?.code ?? pickAccount(request, 'office'),
        taxCodeCode: request.taxCodeOptions.find((t) => t.code === 'FI_PURCHASE_STD')?.code,
        deductibilityPercent: 100,
        paymentMethod: request.paymentMethod as any ?? 'BANK_TRANSFER',
        description: request.description ?? 'Office expense',
        category: 'office',
        overallConfidence: 0.94,
        fieldConfidences: { expenseAccount: 0.9, taxCode: 0.96, deductibility: 0.95, paymentMethod: 0.8 },
        reasons: { expenseAccount: 'Supplier history and line text indicate office supplies.' },
      };
    }
    if (text.includes('software')) {
      return {
        expenseAccountCode: request.accountOptions.find((a) => a.name.toLowerCase().includes('software'))?.code,
        taxCodeCode: request.taxCodeOptions.find((t) => t.code === 'FI_PURCHASE_STD')?.code,
        deductibilityPercent: 100,
        paymentMethod: request.paymentMethod as any ?? 'BANK_TRANSFER',
        description: request.description ?? 'Software subscription',
        category: 'software',
        overallConfidence: 0.97,
        fieldConfidences: { expenseAccount: 0.98, taxCode: 0.98, deductibility: 0.97 },
        reasons: { expenseAccount: 'Merchant and line text suggest a software subscription.' },
      };
    }
    if (text.includes('fuel') || text.includes('gas')) {
      return {
        expenseAccountCode: request.accountOptions.find((a) => a.name.toLowerCase().includes('vehicle'))?.code,
        taxCodeCode: request.taxCodeOptions.find((t) => t.code === 'FI_PURCHASE_STD')?.code,
        deductibilityPercent: 100,
        paymentMethod: request.paymentMethod as any ?? 'COMPANY_CARD',
        description: request.description ?? 'Vehicle fuel',
        category: 'vehicle',
        overallConfidence: 0.82,
        fieldConfidences: { expenseAccount: 0.84, taxCode: 0.9, deductibility: 0.6, paymentMethod: 0.7 },
        reasons: { expenseAccount: 'Line text indicates vehicle fuel.' },
      };
    }
    return {
      expenseAccountCode: request.history[0]?.expenseAccountCode ?? pickAccount(request, 'expense'),
      taxCodeCode: request.history[0]?.taxCodeCode ?? request.taxCodeOptions.find((t) => t.code === 'FI_PURCHASE_STD')?.code,
      deductibilityPercent: 100,
      paymentMethod: request.history[0]?.paymentMethod as any ?? request.paymentMethod as any ?? 'BANK_TRANSFER',
      description: request.description ?? 'Expense',
      category: 'other',
      overallConfidence: 0.72,
      fieldConfidences: { expenseAccount: 0.75, taxCode: 0.85, deductibility: 0.8, paymentMethod: 0.7 },
      reasons: { expenseAccount: 'Used the supplier history default account.' },
    };
  }
}

export function createExpenseClassificationProvider(_driver: string | undefined): ExpenseClassificationProvider {
  return new MockExpenseClassificationProvider();
}

export function normalizeRawSuggestion(raw: unknown): RawClassificationSuggestion {
  const parsed = rawSuggestionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.extractionFailed, 'Malformed classification provider response', 422, parsed.error.flatten());
  }
  return parsed.data;
}

export function inputFingerprint(request: ClassificationRequest): string {
  const canonical = JSON.stringify({
    documentType: request.documentType,
    merchant: request.merchant,
    supplierName: request.supplierName,
    businessId: request.businessId,
    vatNumber: request.vatNumber,
    date: request.date,
    total: request.total,
    vatTotal: request.vatTotal,
    description: request.description,
    ocrFields: request.ocrFields,
    lineDescriptions: request.lineDescriptions,
    paymentMethod: request.paymentMethod,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function getLatestClassification(
  client: DbClient,
  tenantId: string,
  purchaseDocumentId: string,
): Promise<any | null> {
  const result = await client.query(
    `SELECT * FROM expense_classification_runs
     WHERE tenant_id = $1 AND purchase_document_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, purchaseDocumentId],
  );
  return result.rows[0] ?? null;
}

export async function saveClassificationRun(
  pool: Db,
  tenantId: string,
  userId: string,
  input: {
    purchaseDocumentId: string;
    provider: string;
    model: string;
    status: ClassificationStatus;
    fingerprint: string;
    requestMetadata: Record<string, unknown>;
    suggestions?: unknown;
    latencyMs?: number;
  },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await client.query(
      `SELECT id FROM expense_classification_runs
       WHERE tenant_id = $1 AND purchase_document_id = $2 AND input_fingerprint = $3
         AND status IN ('READY','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED')
       LIMIT 1`,
      [tenantId, input.purchaseDocumentId, input.fingerprint],
    );
    if (existing.rows[0]) {
      const row = await client.query('SELECT * FROM expense_classification_runs WHERE id = $1', [existing.rows[0].id]);
      return row.rows[0];
    }
    const inserted = await client.query(
      `INSERT INTO expense_classification_runs
         (tenant_id, purchase_document_id, provider, model, status, input_fingerprint,
          request_metadata, suggestions, latency_ms, created_by, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       RETURNING *`,
      [
        tenantId,
        input.purchaseDocumentId,
        input.provider,
        input.model,
        input.status,
        input.fingerprint,
        JSON.stringify(input.requestMetadata),
        input.suggestions ? JSON.stringify(input.suggestions) : null,
        input.latencyMs ?? null,
        userId,
      ],
    );
    return inserted.rows[0];
  });
}

export async function getPurchaseClassificationContext(
  pool: Db,
  tenantId: string,
  purchaseDocumentId: string,
): Promise<{ invoice: any; accounts: AccountOption[]; taxCodes: TaxCodeOption[]; extractions: any[]; history: ClassificationRequest['history']; lineDescriptions: string[] }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoiceResult = await client.query(
      `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2`,
      [purchaseDocumentId, tenantId],
    );
    if (!invoiceResult.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase document not found', 404);
    const invoice = invoiceResult.rows[0];
    const date = String(invoice.invoice_date instanceof Date ? invoice.invoice_date.toISOString().slice(0, 10) : String(invoice.invoice_date ?? new Date().toISOString().slice(0, 10)).slice(0, 10));
    const accountsResult = await client.query(
      `SELECT id, code, name FROM accounts
       WHERE tenant_id = $1 AND is_active AND type IN ('EXPENSE','ASSET')
       ORDER BY code LIMIT 200`,
      [tenantId],
    );
    const taxResult = await client.query(
      `SELECT id, code, rate FROM tax_codes
       WHERE tenant_id = $1 AND is_active AND direction IN ('PURCHASE','BOTH')
         AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
       ORDER BY code LIMIT 100`,
      [tenantId, date],
    );
    const extractionResult = await client.query(
      `SELECT field_name, value, confidence FROM purchase_invoice_extractions
       WHERE purchase_invoice_id = $1 AND tenant_id = $2 ORDER BY field_name`,
      [purchaseDocumentId, tenantId],
    );
    const historyResult = await client.query(
      `SELECT l.expense_account_id, l.tax_code_id, l.deductible_percent_snapshot, pi.payment_method
       FROM purchase_invoice_lines l
       JOIN purchase_invoices pi ON pi.id = l.purchase_invoice_id AND pi.tenant_id = l.tenant_id
       WHERE pi.tenant_id = $1 AND pi.supplier_id = $2 AND pi.status = 'POSTED'
         AND pi.id <> $3
       ORDER BY pi.posted_at DESC LIMIT 20`,
      [tenantId, invoice.supplier_id, purchaseDocumentId],
    );
    const accountCode = new Map<string, string>();
    for (const account of accountsResult.rows) accountCode.set(String(account.id), String(account.code));
    const taxCode = new Map<string, string>();
    for (const tax of taxResult.rows) taxCode.set(String(tax.id), String(tax.code));
    const history = historyResult.rows.map((row: any) => ({
      expenseAccountCode: row.expense_account_id ? accountCode.get(String(row.expense_account_id)) ?? null : null,
      taxCodeCode: row.tax_code_id ? taxCode.get(String(row.tax_code_id)) ?? null : null,
      deductiblePercent: row.deductible_percent_snapshot == null ? null : String(row.deductible_percent_snapshot),
      paymentMethod: row.payment_method ?? null,
    }));
    const linesResult = await client.query(
      `SELECT description FROM purchase_invoice_lines
       WHERE purchase_invoice_id = $1 AND tenant_id = $2 ORDER BY line_number`,
      [purchaseDocumentId, tenantId],
    );
    return {
      invoice,
      accounts: accountsResult.rows.map((row: any) => ({ id: String(row.id), code: String(row.code), name: String(row.name) })),
      taxCodes: taxResult.rows.map((row: any) => ({ id: String(row.id), code: String(row.code), rate: String(row.rate) })),
      extractions: extractionResult.rows,
      history,
      lineDescriptions: linesResult.rows.map((row: any) => String(row.description)),
    } as any;
  });
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value ?? '').slice(0, 10);
}

export async function classifyPurchaseDocument(
  pool: Db,
  tenantId: string,
  userId: string,
  purchaseDocumentId: string,
  provider: ExpenseClassificationProvider,
): Promise<any> {
  const context = await getPurchaseClassificationContext(pool, tenantId, purchaseDocumentId);
  const invoice = context.invoice;
  const request: ClassificationRequest = {
    documentType: String(invoice.document_type ?? 'PURCHASE_INVOICE'),
    merchant: invoice.merchant_name ? String(invoice.merchant_name) : null,
    supplierName: null,
    businessId: null,
    vatNumber: null,
    countryCode: null,
    date: dateOnly(invoice.invoice_date) || null,
    currency: invoice.currency_code ?? null,
    total: invoice.total == null ? null : String(invoice.total),
    vatTotal: invoice.tax_total == null ? null : String(invoice.tax_total),
    paymentMethod: invoice.payment_method ?? null,
    description: invoice.description ?? null,
    category: invoice.category ?? null,
    ocrFields: context.extractions.map((row: any) => ({
      name: String(row.field_name),
      value: String(row.value),
      confidence: row.confidence == null ? null : Number(row.confidence),
    })),
    lineDescriptions: context.lineDescriptions,
    accountOptions: context.accounts,
    taxCodeOptions: context.taxCodes,
    history: context.history,
  };
  const fingerprint = inputFingerprint(request);
  const started = Date.now();
  let raw: RawClassificationSuggestion;
  try {
    raw = normalizeRawSuggestion(await provider.classify(request));
  } catch (error) {
    await saveClassificationRun(pool, tenantId, userId, {
      purchaseDocumentId,
      provider: provider.name,
      model: provider.model,
      status: 'FAILED',
      fingerprint,
      requestMetadata: { error: error instanceof Error ? error.message.slice(0, 200) : 'classification failed' },
      latencyMs: Date.now() - started,
    });
    throw new AppError(ErrorCodes.extractionFailed, 'AI classification unavailable. You can continue manually.', 422);
  }
  const accountById = new Map(context.accounts.map((account) => [account.id, account]));
  const taxById = new Map(context.taxCodes.map((code) => [code.id, code]));
  const accountByCode = new Map(context.accounts.map((account) => [account.code, account]));
  const taxByCode = new Map(context.taxCodes.map((code) => [code.code, code]));
  const expenseAccountId = raw.expenseAccountCode ? accountByCode.get(raw.expenseAccountCode)?.id ?? null : null;
  const taxCodeId = raw.taxCodeCode ? taxByCode.get(raw.taxCodeCode)?.id ?? null : null;
  const suggestions = {
    expenseAccountId,
    expenseAccountCode: raw.expenseAccountCode ?? null,
    taxCodeId,
    taxCodeCode: raw.taxCodeCode ?? null,
    deductibilityPercent: raw.deductibilityPercent ?? null,
    paymentMethod: raw.paymentMethod ?? null,
    projectCode: raw.projectCode ?? null,
    costCenter: raw.costCenter ?? null,
    description: raw.description ?? null,
    category: raw.category ?? null,
    overallConfidence: raw.overallConfidence,
    fieldConfidences: raw.fieldConfidences,
    reasons: raw.reasons,
    invalidFields: {
      expenseAccount: raw.expenseAccountCode && !expenseAccountId ? 'Suggested account is not valid for this tenant' : null,
      taxCode: raw.taxCodeCode && !taxCodeId ? 'Suggested tax code is not valid for this document' : null,
    },
  };
  void accountById;
  void taxById;
  const run = await saveClassificationRun(pool, tenantId, userId, {
    purchaseDocumentId,
    provider: provider.name,
    model: provider.model,
    status: 'READY',
    fingerprint,
    requestMetadata: {
      fingerprint,
      accountOptions: context.accounts.length,
      taxCodeOptions: context.taxCodes.length,
      historySize: context.history.length,
    },
    suggestions,
    latencyMs: Date.now() - started,
  });
  return run;
}

export async function applyClassification(
  pool: Db,
  tenantId: string,
  userId: string,
  purchaseDocumentId: string,
  input: {
    expenseAccountId?: string;
    taxCodeId?: string;
    deductibilityPercent?: string;
    paymentMethod?: string;
    projectCode?: string;
    costCenter?: string;
    description?: string;
    category?: string;
  },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoiceResult = await client.query(
      `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2`,
      [purchaseDocumentId, tenantId],
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase document not found', 404);
    if (!['DRAFT', 'INGESTED', 'NEEDS_REVIEW'].includes(String(invoice.status))) {
      throw new AppError(ErrorCodes.purchaseImmutable, 'Classification can only be applied to editable purchase documents', 409);
    }
    if (input.expenseAccountId) {
      const account = await client.query(
        `SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2 AND is_active`,
        [input.expenseAccountId, tenantId],
      );
      if (!account.rows[0]) throw new AppError(ErrorCodes.accountNotFound, 'Suggested account is invalid', 400);
    }
    if (input.taxCodeId) {
      const tax = await client.query(
        `SELECT id FROM tax_codes WHERE id = $1 AND tenant_id = $2 AND is_active
           AND direction IN ('PURCHASE','BOTH')
           AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)`,
        [input.taxCodeId, tenantId, dateOnly(invoice.invoice_date) || '2026-01-01'],
      );
      if (!tax.rows[0]) throw new AppError(ErrorCodes.taxCodeNotValidOnDate, 'Suggested tax code is invalid for the document date', 400);
    }
    const sets: string[] = [];
    const values: unknown[] = [purchaseDocumentId, tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.paymentMethod) add('payment_method', input.paymentMethod);
    if (input.description !== undefined) add('description', input.description || null);
    if (input.category !== undefined) add('category', input.category || null);
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      await client.query(`UPDATE purchase_invoices SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, values);
    }
    if (input.expenseAccountId || input.taxCodeId || input.deductibilityPercent !== undefined) {
      const lineSets: string[] = [];
      const lineValues: unknown[] = [purchaseDocumentId, tenantId];
      if (input.expenseAccountId) {
        lineValues.push(input.expenseAccountId);
        lineSets.push(`expense_account_id = $${lineValues.length}`);
      }
      if (input.taxCodeId) {
        lineValues.push(input.taxCodeId);
        lineSets.push(`tax_code_id = $${lineValues.length}`);
      }
      if (input.deductibilityPercent !== undefined) {
        lineValues.push(input.deductibilityPercent);
        lineSets.push(`deductible_percent_snapshot = $${lineValues.length}`);
      }
      if (input.costCenter !== undefined) {
        lineValues.push(input.costCenter || null);
        lineSets.push(`cost_center = $${lineValues.length}`);
      }
      if (lineSets.length > 0) {
        await client.query(
          `UPDATE purchase_invoice_lines SET ${lineSets.join(', ')}
           WHERE purchase_invoice_id = $1 AND tenant_id = $2`,
          lineValues,
        );
      }
    }
    const run = await client.query(
      `UPDATE expense_classification_runs
       SET status = 'ACCEPTED', accepted_fields = $3::jsonb, final_outcome = $4::jsonb
       WHERE tenant_id = $1 AND purchase_document_id = $2
         AND id = (SELECT id FROM expense_classification_runs
                   WHERE tenant_id = $1 AND purchase_document_id = $2
                   ORDER BY created_at DESC LIMIT 1)
       RETURNING *`,
      [
        tenantId,
        purchaseDocumentId,
        JSON.stringify(Object.keys(input)),
        JSON.stringify(input),
      ],
    );
    void run;
    return { applied: true };
  });
}
