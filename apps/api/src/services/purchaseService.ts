import Decimal from 'decimal.js';
import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  normalizeSupplierInvoiceNumber,
  parseEinvoice,
  type CanonicalPurchaseInvoice,
  type EinvoiceFormat,
} from './purchaseInvoiceParsers';
import { withTenantTransaction } from './tenantService';
import { createJournalDraftInTransaction, postJournalEntryInTransaction } from './accountingService';
import { getDocumentDownload, uploadDocument, type LocalObjectStorageProvider } from './documentStorage';
import type { RegistryCompany } from './businessRegistryTypes';
import {
  calculateVat,
  isTaxDirectionAllowed,
  legalNoteForLanguage,
  treatmentFromLegacyType,
  type TaxCodeLike,
} from './vatEngineService';
import type { DocumentOcrProvider, OcrResult } from './ocrService';

export type PurchaseStatus =
  | 'INGESTED'
  | 'DRAFT'
  | 'NEEDS_REVIEW'
  | 'READY_FOR_APPROVAL'
  | 'APPROVED'
  | 'POSTED'
  | 'REJECTED'
  | 'CANCELLED_DRAFT'
  | 'CORRECTED';

export interface PurchaseLineDraft {
  description: string;
  quantity?: string | null;
  unit?: string | null;
  unit_price?: string | null;
  net_amount?: string | null;
  tax_code_id: string;
  tax_rate?: string | null;
  tax_type?: string | null;
  tax_amount?: string | null;
  deductible_percent?: string | null;
  expense_account_id?: string | null;
  cost_center?: string | null;
}

export interface PurchaseDraftInput {
  supplier_id?: string | null;
  merchant_name?: string | null;
  supplier_invoice_number?: string;
  invoice_date: string;
  due_date?: string;
  currency_code?: string;
  supplier_reference?: string | null;
  supplier_iban?: string | null;
  source_type?: string;
  document_type?: string;
  payment_method?: string;
  payment_status?: string;
  description?: string | null;
  lines: PurchaseLineDraft[];
}

export interface SupplierInput {
  name: string;
  business_id?: string | null;
  vat_id?: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country_code?: string;
  language?: string;
  payment_terms_days?: number;
  default_currency?: string;
  iban?: string | null;
  e_invoice_address?: string | null;
  e_invoice_operator?: string | null;
  default_expense_account_id?: string | null;
  default_tax_code_id?: string | null;
  registry_source?: string | null;
  registry_source_id?: string | null;
  registry_fetched_at?: string | null;
  registry_snapshot?: RegistryCompany | null;
}

export interface PurchaseSettingsPatch {
  accounts_payable_account_id?: string | null;
  default_expense_account_id?: string | null;
  input_vat_account_id?: string | null;
  reverse_charge_input_account_id?: string | null;
  reverse_charge_output_account_id?: string | null;
  cash_account_id?: string | null;
  company_card_account_id?: string | null;
  employee_payable_account_id?: string | null;
  require_separate_approver?: boolean;
  auto_post_on_approval?: boolean;
  default_currency?: string;
}

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const cents = (value: Decimal | string): Decimal => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function toDateString(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const raw = String(value ?? '');
  return raw.slice(0, 10);
}

function normalizeRow(row: any): any {
  if (!row) return row;
  for (const key of ['invoice_date', 'due_date', 'created_at', 'updated_at', 'reviewed_at', 'approved_at', 'posted_at']) {
    if (row[key] && !(typeof row[key] === 'string')) row[key] = toDateString(row[key]);
  }
  for (const key of ['subtotal', 'tax_total', 'total', 'source_total', 'net_amount', 'tax_amount', 'gross_amount', 'unit_price', 'quantity']) {
    if (row[key] === undefined || row[key] === null || row[key] === '') continue;
    const numeric = Number(row[key]);
    if (Number.isFinite(numeric)) row[key] = numeric.toFixed(2);
  }
  return row;
}

async function ensurePurchaseSettingsRow(client: DbClient, tenantId: string): Promise<any> {
  const existing = await client.query('SELECT * FROM purchase_settings WHERE tenant_id = $1', [tenantId]);
  if (existing.rows[0]) return existing.rows[0];
  const company = await client.query(
    `SELECT id FROM companies WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  const inserted = await client.query(
    `INSERT INTO purchase_settings (tenant_id, company_id, require_separate_approver, auto_post_on_approval, default_currency)
     VALUES ($1, $2, false, false, 'EUR')
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING *`,
    [tenantId, company.rows[0]?.id ?? null],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const readAgain = await client.query('SELECT * FROM purchase_settings WHERE tenant_id = $1', [tenantId]);
  if (!readAgain.rows[0]) throw new AppError(ErrorCodes.purchaseAccountMappingMissing, 'Purchase settings unavailable', 500);
  return readAgain.rows[0];
}

async function validateCurrency(client: DbClient, code: string): Promise<void> {
  const result = await client.query('SELECT code FROM currencies WHERE code = $1 AND is_active', [code]);
  if (!result.rows[0]) throw new AppError(ErrorCodes.currencyInvalid, 'Currency is not active', 400);
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
export async function listSuppliers(
  pool: Db,
  tenantId: string,
  filters: { search?: string; active?: boolean; limit?: number; offset?: number } = {},
): Promise<{ suppliers: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(
        `(name ILIKE $${values.length} OR business_id ILIKE $${values.length} OR vat_id ILIKE $${values.length})`,
      );
    }
    if (filters.active !== undefined) {
      values.push(filters.active);
      clauses.push(`is_active = $${values.length}`);
    }
    const where = `WHERE tenant_id = $1 AND is_supplier${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
    const total = await client.query(`SELECT count(*)::int AS total FROM business_parties ${where}`, values);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = await client.query(
      `SELECT * FROM business_parties ${where}
       ORDER BY name, created_at LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return { suppliers: rows.rows.map(normalizeRow), total: Number(total.rows[0]?.total ?? 0) };
  });
}

export async function getSupplier(pool: Db, tenantId: string, supplierId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_supplier',
      [supplierId, tenantId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier not found', 404);
    return normalizeRow(result.rows[0]);
  });
}

export async function createSupplier(
  pool: Db,
  tenantId: string,
  userId: string,
  input: SupplierInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const name = String(input.name ?? '').trim();
    if (!name) throw new AppError(ErrorCodes.invalidCustomer, 'Supplier name is required', 400);
    const currency = String(input.default_currency ?? 'EUR').toUpperCase();
    await validateCurrency(client, currency);
    if (input.default_expense_account_id) {
      const account = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2',
        [input.default_expense_account_id, tenantId],
      );
      if (!account.rows[0]) throw new AppError(ErrorCodes.purchaseAccountMappingMissing, 'Expense account outside tenant', 400);
    }
    const result = await client.query(
      `INSERT INTO business_parties
         (tenant_id, name, is_customer, is_supplier, business_id, vat_id, email, phone,
          address_line1, address_line2, postal_code, city, country_code, language,
          payment_terms_days, default_currency, iban, e_invoice_address, e_invoice_operator,
          default_expense_account_id, default_tax_code_id,
          registry_source, registry_source_id, registry_fetched_at, registry_snapshot,
          is_active)
       VALUES ($1, $2, false, true, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18, $19, $20, $21, $22, $23, true)
       RETURNING *`,
      [
        tenantId,
        name,
        input.business_id || null,
        input.vat_id || null,
        input.email || null,
        input.phone || null,
        input.address_line1 || null,
        input.address_line2 || null,
        input.postal_code || null,
        input.city || null,
        String(input.country_code ?? 'FI').toUpperCase(),
        String(input.language ?? 'fi').toLowerCase(),
        input.payment_terms_days ?? 14,
        currency,
        input.iban || null,
        input.e_invoice_address || null,
        input.e_invoice_operator || null,
        input.default_expense_account_id || null,
        input.default_tax_code_id || null,
        input.registry_source || null,
        input.registry_source_id || null,
        input.registry_fetched_at || null,
        input.registry_snapshot ? JSON.stringify(input.registry_snapshot) : null,
      ],
    );
    return normalizeRow(result.rows[0]);
  });
}

export async function updateSupplier(
  pool: Db,
  tenantId: string,
  supplierId: string,
  patch: Partial<SupplierInput>,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const current = await client.query(
      'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2',
      [supplierId, tenantId],
    );
    if (!current.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier not found', 404);
    const sets: string[] = [];
    const values: unknown[] = [supplierId, tenantId];
    const setValue = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) setValue('name', String(patch.name).trim());
    if (patch.business_id !== undefined) setValue('business_id', patch.business_id || null);
    if (patch.vat_id !== undefined) setValue('vat_id', patch.vat_id || null);
    if (patch.email !== undefined) setValue('email', patch.email || null);
    if (patch.phone !== undefined) setValue('phone', patch.phone || null);
    if (patch.address_line1 !== undefined) setValue('address_line1', patch.address_line1 || null);
    if (patch.address_line2 !== undefined) setValue('address_line2', patch.address_line2 || null);
    if (patch.postal_code !== undefined) setValue('postal_code', patch.postal_code || null);
    if (patch.city !== undefined) setValue('city', patch.city || null);
    if (patch.country_code !== undefined) setValue('country_code', String(patch.country_code).toUpperCase());
    if (patch.language !== undefined) setValue('language', String(patch.language).toLowerCase());
    if (patch.payment_terms_days !== undefined) setValue('payment_terms_days', patch.payment_terms_days);
    if (patch.default_currency !== undefined) {
      await validateCurrency(client, String(patch.default_currency).toUpperCase());
      setValue('default_currency', String(patch.default_currency).toUpperCase());
    }
    if (patch.iban !== undefined) setValue('iban', patch.iban || null);
    if (patch.e_invoice_address !== undefined) setValue('e_invoice_address', patch.e_invoice_address || null);
    if (patch.e_invoice_operator !== undefined) setValue('e_invoice_operator', patch.e_invoice_operator || null);
    if (patch.default_expense_account_id !== undefined) setValue('default_expense_account_id', patch.default_expense_account_id || null);
    if (patch.default_tax_code_id !== undefined) setValue('default_tax_code_id', patch.default_tax_code_id || null);
    if (patch.registry_source !== undefined) setValue('registry_source', patch.registry_source || null);
    if (patch.registry_source_id !== undefined) setValue('registry_source_id', patch.registry_source_id || null);
    if (patch.registry_fetched_at !== undefined) setValue('registry_fetched_at', patch.registry_fetched_at || null);
    if (patch.registry_snapshot !== undefined) {
      setValue('registry_snapshot', patch.registry_snapshot ? JSON.stringify(patch.registry_snapshot) : null);
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'No supplier fields to update', 400);
    sets.push('updated_at = now()');
    const result = await client.query(
      `UPDATE business_parties SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );
    return normalizeRow(result.rows[0]);
  });
}

export async function setSupplierActive(
  pool: Db,
  tenantId: string,
  supplierId: string,
  active: boolean,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE business_parties SET is_active = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND is_supplier RETURNING *`,
      [supplierId, tenantId, active],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier not found', 404);
    return normalizeRow(result.rows[0]);
  });
}

export async function getPurchaseSettings(pool: Db, tenantId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const settings = await ensurePurchaseSettingsRow(client, tenantId);
    return normalizeRow(settings);
  });
}

export async function updatePurchaseSettings(
  pool: Db,
  tenantId: string,
  patch: PurchaseSettingsPatch,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    await ensurePurchaseSettingsRow(client, tenantId);
    const sets: string[] = [];
    const values: unknown[] = [tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    const accountFields: Array<[string, unknown]> = [
      ['accounts_payable_account_id', patch.accounts_payable_account_id],
      ['default_expense_account_id', patch.default_expense_account_id],
      ['input_vat_account_id', patch.input_vat_account_id],
      ['reverse_charge_input_account_id', patch.reverse_charge_input_account_id],
      ['reverse_charge_output_account_id', patch.reverse_charge_output_account_id],
      ['cash_account_id', patch.cash_account_id],
      ['company_card_account_id', patch.company_card_account_id],
      ['employee_payable_account_id', patch.employee_payable_account_id],
    ];
    if (accountFields.some(([, value]) => value !== undefined)) {
      for (const [column, value] of accountFields) {
        if (value) {
          const account = await client.query(
            'SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2',
            [value, tenantId],
          );
          if (!account.rows[0]) throw new AppError(ErrorCodes.purchaseAccountMappingMissing, 'Account outside tenant', 400);
        }
        add(column, value || null);
      }
    }
    if (patch.require_separate_approver !== undefined) add('require_separate_approver', patch.require_separate_approver);
    if (patch.auto_post_on_approval !== undefined) add('auto_post_on_approval', patch.auto_post_on_approval);
    if (patch.default_currency !== undefined) {
      await validateCurrency(client, patch.default_currency.toUpperCase());
      add('default_currency', patch.default_currency.toUpperCase());
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'No purchase settings to update', 400);
    sets.push('updated_at = now()');
    const result = await client.query(
      `UPDATE purchase_settings SET ${sets.join(', ')} WHERE tenant_id = $1 RETURNING *`,
      values,
    );
    return normalizeRow(result.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Line/total math and helpers
// ---------------------------------------------------------------------------
function loadTaxCodesForDate(client: DbClient, tenantId: string, ids: string[], date: string): Promise<Map<string, any>> {
  return client.query(
    `SELECT id, code, name, rate, type, reporting_mapping, is_active,
            direction, treatment, reverse_charge, intra_eu, is_export, is_import,
            deductible_percent, legal_notes, is_system
     FROM tax_codes
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active
       AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)`,
    [tenantId, ids, date],
  ).then((result) => {
    const map = new Map<string, any>();
    for (const row of result.rows) map.set(String(row.id), row);
    return map;
  });
}

export function computePurchaseLine(input: {
  quantity?: string | null;
  unitPrice?: string | null;
  netAmount?: string | null;
  taxCode: TaxCodeLike;
  deductiblePercent?: string | null;
  invoiceLanguage?: string | null;
}): {
  net: string;
  tax: string;
  gross: string;
  treatment: string;
  classification: string;
  taxCodeSnapshot: string;
  deductiblePercent: string;
  taxLegalNote: string;
  reportableTax: string;
  expenseAmount: string;
  payableAmount: string;
} {
  let net: Decimal;
  if (input.netAmount !== null && input.netAmount !== undefined) {
    net = cents(new Decimal(input.netAmount));
  } else {
    const quantity = new Decimal(input.quantity ?? '1');
    const unitPrice = new Decimal(input.unitPrice ?? '0');
    net = cents(quantity.mul(unitPrice));
  }
  const taxCode = input.taxCode;
  const treatment = taxCode.treatment ?? treatmentFromLegacyType(String(taxCode.type ?? 'VAT'));
  const calc = calculateVat({
    direction: 'PURCHASE',
    treatment,
    rate: String(taxCode.rate),
    netAmount: net,
    deductiblePercent: input.deductiblePercent ?? taxCode.deductible_percent,
    legalNotes: taxCode.legal_notes,
    language: input.invoiceLanguage,
  });
  return {
    net: net.toFixed(2),
    tax: calc.invoiceTaxAmount,
    gross: calc.grossAmount,
    treatment,
    classification: calc.classification,
    taxCodeSnapshot: String(taxCode.code),
    deductiblePercent: String(input.deductiblePercent ?? taxCode.deductible_percent ?? '100'),
    taxLegalNote: calc.legalNote,
    reportableTax: calc.reportableTaxAmount,
    expenseAmount: calc.expenseAmount,
    payableAmount: calc.payableAmount,
  };
}

function supplierSnapshot(row: any): Record<string, unknown> {
  return {
    name: row.name,
    business_id: row.business_id,
    vat_id: row.vat_id,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    postal_code: row.postal_code,
    city: row.city,
    country_code: row.country_code,
    iban: row.iban,
    e_invoice_address: row.e_invoice_address,
    e_invoice_operator: row.e_invoice_operator,
  };
}

export function resolvePurchaseCounterAccount(
  paymentMethod: string,
  paymentStatus: string,
  settings: {
    accounts_payable_account_id?: string | null;
    cash_account_id?: string | null;
    company_card_account_id?: string | null;
    employee_payable_account_id?: string | null;
  },
): { accountId: string | null; kind: 'AP' | 'CASH' | 'COMPANY_CARD' | 'EMPLOYEE_PAYABLE' | null; paidAtPurchase: boolean } {
  const method = String(paymentMethod ?? 'BANK_TRANSFER');
  const status = String(paymentStatus ?? 'UNPAID');
  const paidAtPurchase = status === 'PAID_AT_PURCHASE' || (status === 'PAID' && method !== 'BANK_TRANSFER');
  if (!paidAtPurchase) {
    return { accountId: settings.accounts_payable_account_id ?? null, kind: 'AP', paidAtPurchase: false };
  }
  if (method === 'CASH') {
    return { accountId: settings.cash_account_id ?? null, kind: 'CASH', paidAtPurchase: true };
  }
  if (method === 'COMPANY_CARD') {
    return { accountId: settings.company_card_account_id ?? null, kind: 'COMPANY_CARD', paidAtPurchase: true };
  }
  if (method === 'PERSONAL_CARD' || method === 'EMPLOYEE_PAID') {
    return { accountId: settings.employee_payable_account_id ?? null, kind: 'EMPLOYEE_PAYABLE', paidAtPurchase: true };
  }
  return { accountId: settings.accounts_payable_account_id ?? null, kind: 'AP', paidAtPurchase: true };
}

async function validateLines(
  client: DbClient,
  tenantId: string,
  invoiceDate: string,
  lines: PurchaseLineDraft[],
  defaultExpenseAccountId?: string | null,
): Promise<Array<{ input: PurchaseLineDraft; tax: any; computed: ReturnType<typeof computePurchaseLine>; expenseAccountId: string }>> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(ErrorCodes.purchaseHasNoLines, 'Purchase invoice requires lines', 400);
  }
  const taxIds = [...new Set(lines.map((line) => line.tax_code_id))];
  const taxMap = await loadTaxCodesForDate(client, tenantId, taxIds, invoiceDate);
  const accountIds = [...new Set([...lines.map((line) => line.expense_account_id), defaultExpenseAccountId])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const accounts = accountIds.length
    ? await client.query('SELECT id FROM accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [
        tenantId,
        accountIds,
      ])
    : { rows: [] as any[] };
  const accountSet = new Set(accounts.rows.map((row: any) => String(row.id)));
  const result: Array<{ input: PurchaseLineDraft; tax: any; computed: ReturnType<typeof computePurchaseLine>; expenseAccountId: string }> = [];
  for (const line of lines) {
    if (!String(line.description ?? '').trim()) {
      throw new AppError(ErrorCodes.invalidPurchaseLine, 'Line description is required', 400);
    }
    const tax = taxMap.get(line.tax_code_id);
    if (!tax) throw new AppError(ErrorCodes.invoiceTaxCodeInvalid, 'Tax code is not active for the invoice date', 400);
    if (!isTaxDirectionAllowed(String(tax.direction ?? 'BOTH') as any, 'PURCHASE')) {
      throw new AppError(
        ErrorCodes.taxCodeDirectionIncompatible,
        'Tax code is not valid for purchase invoices',
        400,
      );
    }
    const deductible = line.deductible_percent ?? String(tax.deductible_percent ?? '100');
    const deductibleDecimal = new Decimal(deductible);
    if (deductibleDecimal.lessThan(0) || deductibleDecimal.greaterThan(100)) {
      throw new AppError(ErrorCodes.deductibilityInvalid, 'Deductibility must be between 0 and 100 percent', 400);
    }
    const expenseAccountId = line.expense_account_id || defaultExpenseAccountId;
    if (!expenseAccountId || !accountSet.has(String(expenseAccountId))) {
      throw new AppError(ErrorCodes.invalidPurchaseLine, 'Expense account is required and must belong to the tenant', 400);
    }
    const computed = computePurchaseLine({
      quantity: line.quantity ?? null,
      unitPrice: line.unit_price ?? null,
      netAmount: line.net_amount ?? null,
      taxCode: tax,
      deductiblePercent: deductible,
    });
    result.push({ input: line, tax, computed, expenseAccountId: String(expenseAccountId) });
  }
  return result;
}

function totalsOf(computed: Array<{ computed: ReturnType<typeof computePurchaseLine> }>): { subtotal: string; taxTotal: string; total: string } {
  let subtotal = new Decimal(0);
  let tax = new Decimal(0);
  for (const item of computed) {
    subtotal = subtotal.plus(item.computed.net);
    tax = tax.plus(item.computed.tax);
  }
  return { subtotal: subtotal.toFixed(2), taxTotal: tax.toFixed(2), total: subtotal.plus(tax).toFixed(2) };
}

async function insertPurchaseLines(
  client: DbClient,
  tenantId: string,
  invoiceId: string,
  rows: Array<{ input: PurchaseLineDraft; tax: any; computed: ReturnType<typeof computePurchaseLine>; expenseAccountId: string }>,
): Promise<void> {
  let lineNumber = 1;
  for (const item of rows) {
    await client.query(
      `INSERT INTO purchase_invoice_lines
         (tenant_id, purchase_invoice_id, line_number, description, quantity, unit, unit_price,
          net_amount, tax_code_id, tax_rate_snapshot, tax_type_snapshot, reporting_mapping_snapshot,
          tax_amount, gross_amount, expense_account_id, cost_center,
          tax_code_snapshot, tax_treatment_snapshot, deductible_percent_snapshot, tax_legal_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        tenantId,
        invoiceId,
        lineNumber,
        String(item.input.description).trim(),
        item.input.quantity ?? '1',
        item.input.unit ?? '',
        item.input.unit_price ?? '0',
        item.computed.net,
        item.tax.id,
        String(item.tax.rate),
        item.input.tax_type ?? String(item.tax.type),
        item.tax.reporting_mapping ? String(item.tax.reporting_mapping) : null,
        item.computed.tax,
        item.computed.gross,
        item.expenseAccountId,
        item.input.cost_center ?? null,
        item.computed.taxCodeSnapshot,
        item.computed.treatment,
        item.computed.deductiblePercent,
        item.computed.taxLegalNote,
      ],
    );
    lineNumber += 1;
  }
}

async function getPurchaseById(client: DbClient, tenantId: string, purchaseId: string): Promise<any> {
  const result = await client.query(
    `SELECT pi.*, bp.name AS supplier_name, je.entry_number AS journal_entry_number
     FROM purchase_invoices pi
     LEFT JOIN business_parties bp ON bp.id = pi.supplier_id AND bp.tenant_id = pi.tenant_id
     LEFT JOIN journal_entries je ON je.id = pi.accounting_journal_entry_id
     WHERE pi.id = $1 AND pi.tenant_id = $2`,
    [purchaseId, tenantId],
  );
  if (!result.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase invoice not found', 404);
  const lines = await client.query(
    `SELECT * FROM purchase_invoice_lines
     WHERE purchase_invoice_id = $1 AND tenant_id = $2 ORDER BY line_number`,
    [purchaseId, tenantId],
  );
  const approvals = await client.query(
    `SELECT pa.*, u.email AS actor_email
     FROM purchase_invoice_approvals pa
     LEFT JOIN users u ON u.id = pa.actor_id
     WHERE pa.purchase_invoice_id = $1 AND pa.tenant_id = $2 ORDER BY pa.created_at`,
    [purchaseId, tenantId],
  );
  return {
    ...normalizeRow(result.rows[0]),
    lines: lines.rows.map(normalizeRow),
    approvals: approvals.rows,
  };
}

async function lockPurchase(client: DbClient, tenantId: string, purchaseId: string): Promise<any> {
  const result = await client.query(
    'SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [purchaseId, tenantId],
  );
  if (!result.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase invoice not found', 404);
  return result.rows[0];
}

async function recordApproval(
  client: DbClient,
  tenantId: string,
  purchaseId: string,
  action: string,
  actorId: string | null,
  reason = '',
): Promise<void> {
  await client.query(
    `INSERT INTO purchase_invoice_approvals (tenant_id, purchase_invoice_id, action, actor_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, purchaseId, action, actorId, reason],
  );
}

async function findDuplicate(
  client: DbClient,
  tenantId: string,
  supplierId: string,
  normalizedNumber: string,
  invoiceDate: string,
): Promise<any> {
  if (!supplierId || !normalizedNumber) return null;
  const result = await client.query(
    `SELECT id, status, total, invoice_date FROM purchase_invoices
     WHERE tenant_id = $1 AND supplier_id = $2 AND supplier_invoice_number_normalized = $3
       AND invoice_date = $4::date AND status NOT IN ('REJECTED','CANCELLED_DRAFT','CORRECTED')
     LIMIT 1`,
    [tenantId, supplierId, normalizedNumber, invoiceDate],
  );
  return result.rows[0] ?? null;
}

async function detectDuplicateWarning(
  client: DbClient,
  tenantId: string,
  purchase: any,
): Promise<string | null> {
  const values: unknown[] = [tenantId, purchase.id];
  const clauses: string[] = [
    `id <> $2`,
    `status NOT IN ('REJECTED','CANCELLED_DRAFT','CORRECTED')`,
  ];
  if (purchase.supplier_id) {
    values.push(purchase.supplier_id);
    clauses.push(`supplier_id = $${values.length}`);
  } else {
    clauses.push(`supplier_id IS NULL`);
  }
  if (purchase.invoice_date) {
    const dateValue = purchase.invoice_date instanceof Date
      ? `${purchase.invoice_date.getFullYear()}-${String(purchase.invoice_date.getMonth() + 1).padStart(2, '0')}-${String(purchase.invoice_date.getDate()).padStart(2, '0')}`
      : String(purchase.invoice_date).slice(0, 10);
    values.push(dateValue);
    clauses.push(`invoice_date = $${values.length}::date`);
  }
  // Exact source-file hash duplicate is the strongest signal and takes
  // priority over softer date/total heuristics.
  const ownHash = await client.query(
    `SELECT dv.sha256
     FROM purchase_invoice_documents pid
     JOIN document_versions dv ON dv.id = pid.document_version_id AND dv.tenant_id = pid.tenant_id
     WHERE pid.purchase_invoice_id = $2 AND pid.tenant_id = $1 AND dv.sha256 IS NOT NULL
     LIMIT 1`,
    [tenantId, purchase.id],
  );
  if (ownHash.rows[0]) {
    const hashMatch = await client.query(
      `SELECT pid.purchase_invoice_id
       FROM purchase_invoice_documents pid
       JOIN document_versions dv ON dv.id = pid.document_version_id AND dv.tenant_id = pid.tenant_id
       WHERE pid.tenant_id = $1 AND dv.sha256 = $2 AND pid.purchase_invoice_id <> $3
       LIMIT 1`,
      [tenantId, String(ownHash.rows[0].sha256), purchase.id],
    );
    if (hashMatch.rows[0]) {
      return 'Possible duplicate: identical source file was already uploaded.';
    }
  }
  const total = String(purchase.total ?? '0');
  values.push(total);
  clauses.push(`ABS(total - $${values.length}::numeric) < 0.01`);
  const similar = await client.query(
    `SELECT document_type, merchant_name, supplier_invoice_number, invoice_date, total
     FROM purchase_invoices
     WHERE tenant_id = $1 AND ${clauses.join(' AND ')}
     ORDER BY created_at DESC LIMIT 1`,
    values,
  );
  if (similar.rows[0]) {
    const row = similar.rows[0];
    const label = row.merchant_name || String(row.supplier_invoice_number ?? 'document');
    return `Possible duplicate: same supplier, date and total as ${label}.`;
  }
  return null;
}

async function matchSupplier(
  client: DbClient,
  tenantId: string,
  canonical: CanonicalPurchaseInvoice,
): Promise<{ supplierId: string | null; reason: string | null; ambiguous: boolean }> {
  const supplier = canonical.supplier;
  const signals: Array<{ value: string | null; reason: string }> = [
    { value: supplier.businessId, reason: 'MATCH_BUSINESS_ID' },
    { value: supplier.vatId, reason: 'MATCH_VAT_ID' },
    { value: supplier.eInvoiceAddress, reason: 'MATCH_EINVOICE_ADDRESS' },
    { value: supplier.iban, reason: 'MATCH_IBAN' },
    { value: supplier.name, reason: 'MATCH_NAME' },
  ];
  const candidates = new Set<string>();
  const reasons = new Map<string, string>();
  for (const signal of signals) {
    if (!signal.value) continue;
    const value = signal.value.trim().toUpperCase();
    const result = await client.query(
      `SELECT id FROM business_parties
       WHERE tenant_id = $1 AND is_supplier AND is_active
         AND (
           upper(coalesce(business_id,'')) = $2
           OR upper(coalesce(vat_id,'')) = $2
           OR upper(coalesce(e_invoice_address,'')) = $2
           OR upper(coalesce(iban,'')) = $2
           OR upper(coalesce(name,'')) = $2
         )
       LIMIT 5`,
      [tenantId, value],
    );
    for (const row of result.rows) {
      candidates.add(String(row.id));
      if (!reasons.has(String(row.id))) reasons.set(String(row.id), signal.reason);
    }
  }
  if (candidates.size === 1) {
    const only = [...candidates][0]!;
    return { supplierId: only, reason: reasons.get(only) ?? null, ambiguous: false };
  }
  return { supplierId: null, reason: null, ambiguous: candidates.size > 1 };
}

// ---------------------------------------------------------------------------
// Public purchase operations
// ---------------------------------------------------------------------------
export async function listPurchases(
  pool: Db,
  tenantId: string,
  filters: {
    status?: PurchaseStatus;
    supplierId?: string;
    documentType?: string;
    paymentMethod?: string;
    duplicateWarning?: boolean;
    from?: string;
    to?: string;
    source?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ purchases: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`pi.status = $${values.length}`);
    }
    if (filters.supplierId) {
      values.push(filters.supplierId);
      clauses.push(`pi.supplier_id = $${values.length}`);
    }
    if (filters.documentType) {
      values.push(filters.documentType);
      clauses.push(`pi.document_type = $${values.length}`);
    }
    if (filters.paymentMethod) {
      values.push(filters.paymentMethod);
      clauses.push(`pi.payment_method = $${values.length}`);
    }
    if (filters.duplicateWarning) {
      clauses.push(`pi.duplicate_warning IS NOT NULL`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`pi.invoice_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`pi.invoice_date <= $${values.length}::date`);
    }
    if (filters.source) {
      values.push(filters.source);
      clauses.push(`pi.source_type = $${values.length}`);
    }
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(`(pi.supplier_invoice_number ILIKE $${values.length} OR bp.name ILIKE $${values.length})`);
    }
    const where = `WHERE pi.tenant_id = $1${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
    const total = await client.query(
      `SELECT count(*)::int AS total FROM purchase_invoices pi
       LEFT JOIN business_parties bp ON bp.id = pi.supplier_id AND bp.tenant_id = pi.tenant_id
       ${where}`,
      values,
    );
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = await client.query(
      `SELECT pi.*, bp.name AS supplier_name
       FROM purchase_invoices pi
       LEFT JOIN business_parties bp ON bp.id = pi.supplier_id AND bp.tenant_id = pi.tenant_id
       ${where}
       ORDER BY pi.invoice_date DESC NULLS LAST, pi.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return { purchases: rows.rows.map(normalizeRow), total: Number(total.rows[0]?.total ?? 0) };
  });
}

export async function getPurchase(pool: Db, tenantId: string, purchaseId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, (client) => getPurchaseById(client, tenantId, purchaseId));
}

export async function createPurchaseInvoiceDraft(
  pool: Db,
  tenantId: string,
  userId: string,
  input: PurchaseDraftInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const settings = await ensurePurchaseSettingsRow(client, tenantId);
    let supplierId: string | null = null;
    let supplierRow: any = null;
    if (input.supplier_id) {
      const supplier = await client.query(
        'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_supplier',
        [input.supplier_id, tenantId],
      );
      if (!supplier.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier not found', 404);
      if (!supplier.rows[0].is_active) throw new AppError(ErrorCodes.supplierInactive, 'Supplier is inactive', 409);
      supplierId = input.supplier_id;
      supplierRow = supplier.rows[0];
    }
    const merchantName = String(input.merchant_name ?? supplierRow?.name ?? '').trim();
    if (!merchantName && !supplierId) {
      throw new AppError(ErrorCodes.invalidPurchaseLine, 'Supplier or merchant name is required', 400);
    }
    const invoiceDate = toDateString(input.invoice_date);
    const dueDate = toDateString(input.due_date ?? invoiceDate);
    if (dueDate < invoiceDate) throw new AppError(ErrorCodes.invalidDueDate, 'Due date before invoice date', 400);
    const currency = String(input.currency_code ?? settings.default_currency ?? 'EUR').toUpperCase();
    await validateCurrency(client, currency);
    const rows = await validateLines(client, tenantId, invoiceDate, input.lines, settings.default_expense_account_id);
    const totals = totalsOf(rows);
    const normalized = normalizeSupplierInvoiceNumber(input.supplier_invoice_number ?? '');
    if (supplierId && (await findDuplicate(client, tenantId, supplierId, normalized, invoiceDate))) {
      throw new AppError(ErrorCodes.duplicatePurchase, 'Duplicate supplier invoice', 409);
    }
    const documentType = String(input.document_type ?? 'PURCHASE_INVOICE');
    const paymentMethod = String(input.payment_method ?? 'BANK_TRANSFER');
    const paymentStatus = input.payment_status
      ? String(input.payment_status)
      : paymentMethod === 'BANK_TRANSFER'
        ? 'UNPAID'
        : 'PAID_AT_PURCHASE';
    const snapshot = supplierRow
      ? JSON.stringify(supplierSnapshot(supplierRow))
      : JSON.stringify({ name: merchantName, is_adhoc: true });
    const inserted = await client.query(
      `INSERT INTO purchase_invoices
         (tenant_id, company_id, supplier_id, status, supplier_invoice_number,
          supplier_invoice_number_normalized, invoice_date, due_date, currency_code,
          supplier_reference, supplier_iban, source_type, supplier_snapshot, subtotal,
          tax_total, total, created_by, document_type, payment_method, payment_status,
          merchant_name, description)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6::date, $7::date, $8, $9, $10, 'MANUAL', $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        tenantId,
        settings.company_id ?? null,
        supplierId,
        input.supplier_invoice_number || null,
        normalized || null,
        invoiceDate,
        dueDate,
        currency,
        input.supplier_reference || null,
        input.supplier_iban || null,
        snapshot,
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        userId,
        documentType,
        paymentMethod,
        paymentStatus,
        merchantName || null,
        input.description?.trim() || null,
      ],
    );
    const purchaseId = String(inserted.rows[0].id);
    await insertPurchaseLines(client, tenantId, purchaseId, rows);
    const warning = await detectDuplicateWarning(client, tenantId, inserted.rows[0]);
    if (warning) {
      await client.query('UPDATE purchase_invoices SET duplicate_warning = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2', [
        purchaseId,
        tenantId,
        warning,
      ]);
    }
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function updatePurchaseInvoiceDraft(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  input: PurchaseDraftInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await lockPurchase(client, tenantId, purchaseId);
    if (!['DRAFT', 'INGESTED', 'NEEDS_REVIEW'].includes(String(existing.status))) {
      throw new AppError(ErrorCodes.purchaseNotEditable, 'Purchase invoice is not editable', 409);
    }
    const settings = await ensurePurchaseSettingsRow(client, tenantId);
    let supplierId: string | null = null;
    let supplierRow: any = null;
    if (input.supplier_id) {
      const supplier = await client.query(
        'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_supplier',
        [input.supplier_id, tenantId],
      );
      if (!supplier.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier not found', 404);
      supplierId = input.supplier_id;
      supplierRow = supplier.rows[0];
    }
    const merchantName = String(input.merchant_name ?? supplierRow?.name ?? '').trim();
    if (!merchantName && !supplierId) {
      throw new AppError(ErrorCodes.invalidPurchaseLine, 'Supplier or merchant name is required', 400);
    }
    const invoiceDate = toDateString(input.invoice_date);
    const dueDate = toDateString(input.due_date ?? invoiceDate);
    if (dueDate < invoiceDate) throw new AppError(ErrorCodes.invalidDueDate, 'Due date before invoice date', 400);
    const currency = String(input.currency_code ?? existing.currency_code ?? 'EUR').toUpperCase();
    await validateCurrency(client, currency);
    const rows = await validateLines(client, tenantId, invoiceDate, input.lines, settings.default_expense_account_id);
    const totals = totalsOf(rows);
    const normalized = normalizeSupplierInvoiceNumber(input.supplier_invoice_number ?? '');
    const documentType = String(input.document_type ?? existing.document_type ?? 'PURCHASE_INVOICE');
    const paymentMethod = String(input.payment_method ?? existing.payment_method ?? 'BANK_TRANSFER');
    const paymentStatus = input.payment_status
      ? String(input.payment_status)
      : String(existing.payment_status ?? (paymentMethod === 'BANK_TRANSFER' ? 'UNPAID' : 'PAID_AT_PURCHASE'));
    await client.query(
      `UPDATE purchase_invoices
       SET supplier_id = $3, merchant_name = $4, supplier_invoice_number = $5,
           supplier_invoice_number_normalized = $6,
           invoice_date = $7::date, due_date = $8::date, currency_code = $9,
           supplier_reference = $10, supplier_iban = $11, supplier_snapshot = $12::jsonb,
           subtotal = $13, tax_total = $14, total = $15, document_type = $16,
           payment_method = $17, payment_status = $18, description = $19,
           duplicate_warning = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        purchaseId,
        tenantId,
        supplierId,
        merchantName || null,
        input.supplier_invoice_number || null,
        normalized || null,
        invoiceDate,
        dueDate,
        currency,
        input.supplier_reference || null,
        input.supplier_iban || null,
        supplierRow ? JSON.stringify(supplierSnapshot(supplierRow)) : JSON.stringify({ name: merchantName, is_adhoc: true }),
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        documentType,
        paymentMethod,
        paymentStatus,
        input.description?.trim() || null,
      ],
    );
    await client.query('DELETE FROM purchase_invoice_lines WHERE purchase_invoice_id = $1', [purchaseId]);
    await insertPurchaseLines(client, tenantId, purchaseId, rows);
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function reviewPurchaseInvoice(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  userId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await lockPurchase(client, tenantId, purchaseId);
    if (!['INGESTED', 'DRAFT', 'NEEDS_REVIEW'].includes(String(invoice.status))) {
      throw new AppError(ErrorCodes.purchaseNotEditable, 'Purchase invoice cannot be reviewed from this state', 409);
    }
    const lines = await client.query(
      `SELECT count(*)::int AS count FROM purchase_invoice_lines WHERE purchase_invoice_id = $1`,
      [purchaseId],
    );
    if (Number(lines.rows[0]?.count ?? 0) === 0) {
      throw new AppError(ErrorCodes.purchaseHasNoLines, 'Purchase invoice has no lines', 400);
    }
    let snapshot: string;
    if (invoice.supplier_id) {
      const supplier = await client.query('SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2', [
        invoice.supplier_id,
        tenantId,
      ]);
      if (!supplier.rows[0]) throw new AppError(ErrorCodes.supplierNotFound, 'Supplier must be confirmed before review', 400);
      if (!supplier.rows[0].is_active) throw new AppError(ErrorCodes.supplierInactive, 'Supplier is inactive', 409);
      snapshot = JSON.stringify(supplierSnapshot(supplier.rows[0]));
    } else {
      const existingSnapshot = invoice.supplier_snapshot && typeof invoice.supplier_snapshot === 'object'
        ? invoice.supplier_snapshot
        : {};
      if (Object.keys(existingSnapshot).length === 0 && !invoice.merchant_name) {
        throw new AppError(ErrorCodes.supplierNotFound, 'Merchant name must be confirmed before review', 400);
      }
      snapshot = JSON.stringify({
        ...(existingSnapshot as Record<string, unknown>),
        name: existingSnapshot.name ?? invoice.merchant_name ?? '',
        is_adhoc: true,
      });
    }
    await client.query(
      `UPDATE purchase_invoices
       SET status = 'READY_FOR_APPROVAL', supplier_snapshot = $3::jsonb,
           reviewed_by = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('INGESTED','DRAFT','NEEDS_REVIEW')`,
      [purchaseId, tenantId, snapshot, userId],
    );
    await recordApproval(client, tenantId, purchaseId, 'REVIEWED', userId);
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function rejectPurchaseInvoice(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  userId: string,
  reason: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await lockPurchase(client, tenantId, purchaseId);
    if (!['INGESTED', 'DRAFT', 'NEEDS_REVIEW', 'READY_FOR_APPROVAL'].includes(String(invoice.status))) {
      throw new AppError(ErrorCodes.purchaseNotEditable, 'Invoice cannot be rejected from this state', 409);
    }
    await client.query(
      `UPDATE purchase_invoices SET status = 'REJECTED', updated_at = now()
       WHERE id = $1 AND tenant_id = $2
         AND status IN ('INGESTED','DRAFT','NEEDS_REVIEW','READY_FOR_APPROVAL')`,
      [purchaseId, tenantId],
    );
    await recordApproval(client, tenantId, purchaseId, 'REJECTED', userId, reason);
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function approvePurchaseInvoice(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  userId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const settings = await ensurePurchaseSettingsRow(client, tenantId);
    const invoice = await lockPurchase(client, tenantId, purchaseId);
    if (String(invoice.status) !== 'READY_FOR_APPROVAL') {
      throw new AppError(ErrorCodes.approvalRequired, 'Invoice must be ready for approval first', 409);
    }
    if (settings.require_separate_approver === true && String(invoice.created_by) === userId) {
      throw new AppError(ErrorCodes.approverNotAllowed, 'Creator cannot approve when separate approver is required', 403);
    }
    await client.query(
      `UPDATE purchase_invoices
       SET status = 'APPROVED', approved_by = $3, approved_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'READY_FOR_APPROVAL'`,
      [purchaseId, tenantId, userId],
    );
    await recordApproval(client, tenantId, purchaseId, 'APPROVED', userId);
    if (settings.auto_post_on_approval === true) {
      await postApprovedPurchase(client, tenantId, purchaseId, userId);
    }
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

async function postApprovedPurchase(
  client: DbClient,
  tenantId: string,
  purchaseId: string,
  userId: string,
): Promise<void> {
  const settings = await ensurePurchaseSettingsRow(client, tenantId);
  const invoice = await lockPurchase(client, tenantId, purchaseId);
  if (String(invoice.status) !== 'APPROVED') {
    throw new AppError(ErrorCodes.purchaseNotEditable, 'Only approved purchase invoices can be posted', 409);
  }
  const inputVatAccount = settings.input_vat_account_id;
  if (!inputVatAccount) throw new AppError(ErrorCodes.purchaseAccountMappingMissing, 'Input VAT account is not configured', 409);
  const paymentMethod = String(invoice.payment_method ?? 'BANK_TRANSFER');
  const paymentStatus = String(invoice.payment_status ?? 'UNPAID');
  const resolvedCounter = resolvePurchaseCounterAccount(paymentMethod, paymentStatus, settings);
  const paidAtPurchase = resolvedCounter.paidAtPurchase;
  const counterAccount = resolvedCounter.accountId;
  if (!counterAccount) {
    throw new AppError(
      ErrorCodes.purchaseAccountMappingMissing,
      paidAtPurchase ? `${paymentMethod} counter account is not configured` : 'Accounts payable account is not configured',
      409,
    );
  }

  const lineRows = await client.query(
    `SELECT pl.*, tc.code AS tax_code, tc.type AS tax_type, tc.rate AS tax_rate,
            tc.treatment AS tc_treatment, tc.deductible_percent AS tc_deductible,
            tc.legal_notes AS tc_legal_notes, tc.direction AS tc_direction
     FROM purchase_invoice_lines pl
     LEFT JOIN tax_codes tc ON tc.id = pl.tax_code_id AND tc.tenant_id = pl.tenant_id
     WHERE pl.purchase_invoice_id = $1 AND pl.tenant_id = $2
     ORDER BY pl.line_number`,
    [purchaseId, tenantId],
  );
  if (lineRows.rows.length === 0) throw new AppError(ErrorCodes.purchaseHasNoLines, 'No lines to post', 400);

  interface JournalMeta {
    accountId: string;
    description: string;
    debit: string;
    credit: string;
    taxCodeId: string | null;
    appliedTaxRate: string | null;
    taxSnapshot: string | null;
    taxCodeSnapshot: string | null;
    taxTreatmentSnapshot: string | null;
    taxableBaseSnapshot: string | null;
    taxAmountSnapshot: string | null;
    taxDeductibleSnapshot: string | null;
    taxNondeductibleSnapshot: string | null;
    taxLegType: string | null;
    taxReportingClassification: string | null;
    taxLegalNote: string | null;
  }
  const journalLines: JournalMeta[] = [];
  interface LineMeta {
    accountId: string;
    amount: Decimal;
    base: Decimal;
    vatLegType: string | null;
    taxCodeId: string | null;
    taxCodeSnapshot: string;
    taxTreatmentSnapshot: string;
    taxRate: string;
    taxLegacyType: string;
    classification: string;
    taxLegalNote: string;
    taxDeductible: string;
    taxNondeductible: string;
  }
  const expenseGroups = new Map<string, LineMeta>();
  const legGroups = new Map<string, LineMeta>();
  const apTotal = new Decimal(String(invoice.total ?? '0'));
  const reverseInput = settings.reverse_charge_input_account_id;
  const reverseOutput = settings.reverse_charge_output_account_id;

  for (const line of lineRows.rows) {
    const net = new Decimal(String(line.net_amount));
    const joinedTax = line.tax_code
      ? {
          id: String(line.tax_code_id),
          code: String(line.tax_code),
          type: String(line.tax_type ?? 'VAT'),
          rate: String(line.tax_rate),
          treatment: String(line.tc_treatment ?? 'STANDARD'),
          deductible_percent: String(line.tc_deductible ?? '100'),
          legal_notes: line.tc_legal_notes ?? null,
          direction: String(line.tc_direction ?? 'BOTH'),
        }
      : null;
    const treatment =
      String(line.tax_treatment_snapshot ?? '') ||
      (joinedTax ? String(joinedTax.treatment) : treatmentFromLegacyType(String(line.tax_type_snapshot ?? 'VAT')));
    const rate = String(line.tax_rate_snapshot ?? (joinedTax ? joinedTax.rate : '0'));
    const deductible = String(line.deductible_percent_snapshot ?? (joinedTax ? joinedTax.deductible_percent : '100'));
    const taxCodeSnapshot = String(line.tax_code_snapshot ?? (joinedTax ? joinedTax.code : ''));
    const taxLegacyType = String(line.tax_type_snapshot ?? (joinedTax ? joinedTax.type : 'VAT'));
    const legalNoteText = line.tax_legal_note
      ? String(line.tax_legal_note)
      : legalNoteForLanguage(joinedTax ? joinedTax.legal_notes : null, 'fi');
    const calc = calculateVat({
      direction: 'PURCHASE',
      treatment: treatment as any,
      rate,
      netAmount: net,
      deductiblePercent: deductible,
      legalNotes: joinedTax ? joinedTax.legal_notes : null,
      language: 'fi',
    });
    const taxCodeId = line.tax_code_id ? String(line.tax_code_id) : null;
    const meta: Omit<LineMeta, 'accountId' | 'amount' | 'base' | 'vatLegType'> = {
      taxCodeId,
      taxCodeSnapshot,
      taxTreatmentSnapshot: calc.treatment,
      taxRate: calc.rate,
      taxLegacyType,
      classification: calc.classification,
      taxLegalNote: legalNoteText,
      taxDeductible: calc.deductibleTax,
      taxNondeductible: calc.nonDeductibleTax,
    };
    const expenseKey = String(line.expense_account_id);
    const existingExpense = expenseGroups.get(expenseKey);
    if (existingExpense) {
      existingExpense.amount = existingExpense.amount.plus(calc.expenseAmount);
      existingExpense.base = existingExpense.base.plus(net);
    } else {
      expenseGroups.set(expenseKey, {
        accountId: expenseKey,
        amount: new Decimal(calc.expenseAmount),
        base: net,
        ...meta,
        vatLegType: null,
      });
    }
    for (const vatLeg of calc.legs) {
      let accountId: string | null = null;
      if (vatLeg.legType === 'INPUT_VAT') accountId = String(inputVatAccount);
      else if (vatLeg.legType === 'RC_INPUT_VAT') accountId = reverseInput ? String(reverseInput) : null;
      else if (vatLeg.legType === 'RC_OUTPUT_VAT') accountId = reverseOutput ? String(reverseOutput) : null;
      if (!accountId) {
        throw new AppError(
          ErrorCodes.taxMappingMissing,
          `${vatLeg.legType} account is not configured`,
          409,
        );
      }
      const legKey = `${vatLeg.legType}|${accountId}|${String(taxCodeId ?? '')}`;
      const existingLeg = legGroups.get(legKey);
      if (existingLeg) {
        existingLeg.amount = existingLeg.amount.plus(new Decimal(vatLeg.amount));
        existingLeg.base = existingLeg.base.plus(net);
      } else {
        legGroups.set(legKey, {
          accountId,
          amount: new Decimal(vatLeg.amount),
          base: net,
          ...meta,
          vatLegType: vatLeg.legType,
        });
      }
    }
  }
  const docLabel = String(invoice.document_type ?? 'PURCHASE_INVOICE') === 'RECEIPT' ? 'Receipt' : 'Purchase invoice';
  const description = `${docLabel} ${String(invoice.supplier_invoice_number ?? invoice.merchant_name ?? purchaseId)}`;
  for (const group of expenseGroups.values()) {
    journalLines.push({
      accountId: group.accountId,
      description,
      debit: group.amount.toFixed(2),
      credit: '0',
      taxCodeId: group.taxCodeId,
      appliedTaxRate: group.taxRate,
      taxSnapshot: `${group.taxCodeSnapshot}|${group.taxLegacyType}`,
      taxCodeSnapshot: group.taxCodeSnapshot,
      taxTreatmentSnapshot: group.taxTreatmentSnapshot,
      taxableBaseSnapshot: group.base.toFixed(2),
      taxAmountSnapshot: '0.00',
      taxDeductibleSnapshot: group.taxDeductible,
      taxNondeductibleSnapshot: group.taxNondeductible,
      taxLegType: 'EXPENSE',
      taxReportingClassification: group.classification,
      taxLegalNote: group.taxLegalNote,
    });
  }
  const orderedLegs = [...legGroups.values()].sort((a, b) =>
    `${a.vatLegType}|${a.accountId}|${a.taxCodeId ?? ''}`.localeCompare(
      `${b.vatLegType}|${b.accountId}|${b.taxCodeId ?? ''}`,
    ),
  );
  for (const group of orderedLegs) {
    const isOutput = group.vatLegType === 'OUTPUT_VAT' || group.vatLegType === 'RC_OUTPUT_VAT';
    const legType = group.vatLegType ?? 'INPUT_VAT';
    journalLines.push({
      accountId: group.accountId,
      description: `${description} (${legType})`,
      debit: isOutput ? '0' : group.amount.toFixed(2),
      credit: isOutput ? group.amount.toFixed(2) : '0',
      taxCodeId: group.taxCodeId,
      appliedTaxRate: group.taxRate,
      taxSnapshot: `${group.taxCodeSnapshot}|${group.taxLegacyType}`,
      taxCodeSnapshot: group.taxCodeSnapshot,
      taxTreatmentSnapshot: group.taxTreatmentSnapshot,
      taxableBaseSnapshot: group.base.toFixed(2),
      taxAmountSnapshot: group.amount.toFixed(2),
      taxDeductibleSnapshot: isOutput ? '0.00' : group.amount.toFixed(2),
      taxNondeductibleSnapshot: group.taxNondeductible,
      taxLegType: legType,
      taxReportingClassification: group.classification,
      taxLegalNote: group.taxLegalNote,
    });
  }
  journalLines.push({
    accountId: String(counterAccount),
    description,
    debit: '0',
    credit: apTotal.toFixed(2),
    taxCodeId: null,
    appliedTaxRate: null,
    taxSnapshot: null,
    taxCodeSnapshot: null,
    taxTreatmentSnapshot: null,
    taxableBaseSnapshot: null,
    taxAmountSnapshot: null,
    taxDeductibleSnapshot: null,
    taxNondeductibleSnapshot: null,
    taxLegType: null,
    taxReportingClassification: null,
    taxLegalNote: null,
  });

  const entryId = await createJournalDraftInTransaction(client, tenantId, userId, {
    businessDate: toDateString(invoice.invoice_date ?? today()),
    description,
    currencyCode: String(invoice.currency_code ?? 'EUR'),
    sourceType: 'PURCHASE_INVOICE',
    sourceId: purchaseId,
    lines: journalLines,
  });
  const entryNumber = await postJournalEntryInTransaction(client, tenantId, entryId, userId);
  await client.query(
    `UPDATE purchase_invoices
     SET status = 'POSTED', accounting_journal_entry_id = $3, posted_by = $4,
         posted_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'APPROVED'`,
    [purchaseId, tenantId, entryId, userId],
  );
  await recordApproval(client, tenantId, purchaseId, 'POSTED', userId, `journal ${entryNumber}`);
}

export async function postPurchaseInvoice(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  userId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    await postApprovedPurchase(client, tenantId, purchaseId, userId);
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function correctPurchaseInvoice(
  pool: Db,
  tenantId: string,
  purchaseId: string,
  userId: string,
  reason: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await lockPurchase(client, tenantId, purchaseId);
    if (String(invoice.status) !== 'POSTED') {
      throw new AppError(ErrorCodes.purchaseNotEditable, 'Only posted purchase invoices can be corrected', 409);
    }
    if (!reason || reason.trim().length < 3) {
      throw new AppError(ErrorCodes.invalidRequest, 'Correction reason is required', 400);
    }
    const originalLines = await client.query(
      `SELECT account_id, description, debit, credit, tax_code_id, applied_tax_rate,
              tax_snapshot, tax_code_snapshot, tax_treatment_snapshot,
              taxable_base_snapshot, tax_amount_snapshot, tax_deductible_snapshot,
              tax_nondeductible_snapshot, tax_leg_type, tax_reporting_classification,
              tax_legal_note, cost_center, project_code
       FROM journal_lines
       WHERE journal_entry_id = $1 ORDER BY line_number`,
      [invoice.accounting_journal_entry_id],
    );
    const reversalEntry = await client.query(
      `INSERT INTO journal_entries
         (tenant_id, business_date, document_date, description, currency_code, source_type,
          source_id, reversal_of_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'PURCHASE_CORRECTION', $6, $7, $8)
       RETURNING id`,
      [
        tenantId,
        toDateString(invoice.invoice_date ?? today()),
        toDateString(invoice.invoice_date ?? today()),
        `Purchase correction: ${String(invoice.supplier_invoice_number ?? purchaseId)}`,
        String(invoice.currency_code ?? 'EUR'),
        purchaseId,
        invoice.accounting_journal_entry_id ? String(invoice.accounting_journal_entry_id) : null,
        userId,
      ],
    );
    const reversalId = String(reversalEntry.rows[0].id);
    let lineNumber = 1;
    for (const line of originalLines.rows) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, journal_entry_id, line_number, account_id, description, debit, credit,
            currency_code, tax_code_id, applied_tax_rate, tax_snapshot,
            tax_code_snapshot, tax_treatment_snapshot, taxable_base_snapshot,
            tax_amount_snapshot, tax_deductible_snapshot, tax_nondeductible_snapshot,
            tax_leg_type, tax_reporting_classification, tax_legal_note,
            cost_center, project_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          tenantId,
          reversalId,
          lineNumber,
          line.account_id,
          String(line.description),
          String(line.credit),
          String(line.debit),
          String(invoice.currency_code ?? 'EUR'),
          line.tax_code_id ?? null,
          line.applied_tax_rate ?? null,
          line.tax_snapshot ?? null,
          line.tax_code_snapshot ?? null,
          line.tax_treatment_snapshot ?? null,
          line.taxable_base_snapshot ?? null,
          line.tax_amount_snapshot ?? null,
          line.tax_deductible_snapshot ?? null,
          line.tax_nondeductible_snapshot ?? null,
          line.tax_leg_type ?? null,
          line.tax_reporting_classification ?? null,
          line.tax_legal_note ?? null,
          line.cost_center ?? null,
          line.project_code ?? null,
        ],
      );
      lineNumber += 1;
    }
    const entryNumber = await postJournalEntryInTransaction(client, tenantId, reversalId, userId);
    await client.query(
      `INSERT INTO purchase_invoice_corrections
         (tenant_id, purchase_invoice_id, reversal_journal_entry_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, purchaseId, reversalId, reason.trim(), userId],
    );
    await client.query(
      `UPDATE purchase_invoices SET status = 'CORRECTED', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'POSTED'`,
      [purchaseId, tenantId],
    );
    await recordApproval(client, tenantId, purchaseId, 'CORRECTED', userId, reason);
    return { invoice: await getPurchaseById(client, tenantId, purchaseId), reversal_journal_id: reversalId, entryNumber };
  });
}

// ---------------------------------------------------------------------------
// Ingestion / canonical import
// ---------------------------------------------------------------------------
async function createFromCanonical(
  client: DbClient,
  tenantId: string,
  userId: string,
  canonical: CanonicalPurchaseInvoice,
  sourceType: string,
): Promise<any> {
  const settings = await ensurePurchaseSettingsRow(client, tenantId);
  const match = await matchSupplier(client, tenantId, canonical);
  const existingExternal = await client.query(
    `SELECT id FROM purchase_invoices
     WHERE tenant_id = $1 AND source_type = $2 AND source_external_id = $3`,
    [tenantId, sourceType, canonical.sourceExternalId],
  );
  if (existingExternal.rows[0]) {
    throw new AppError(ErrorCodes.duplicateExternalEvent, 'Duplicate external invoice event', 409);
  }
  const supplierId = match.supplierId;
  const invoiceDate = canonical.invoiceDate || today();
  const dueDate = canonical.dueDate ?? invoiceDate;
  const currency = canonical.currency || settings.default_currency || 'EUR';
  await validateCurrency(client, currency);
  const normalized = normalizeSupplierInvoiceNumber(canonical.invoiceNumber);
  if (supplierId && (await findDuplicate(client, tenantId, supplierId, normalized, invoiceDate))) {
    throw new AppError(ErrorCodes.duplicatePurchase, 'Duplicate supplier invoice', 409);
  }

  const lines: PurchaseLineDraft[] = canonical.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_price: line.unitPrice,
    net_amount: line.netAmount,
    tax_code_id: '',
    tax_rate: line.vatRate,
    tax_type: line.vatType,
    tax_amount: line.taxAmount,
    expense_account_id: '',
  }));
  const convertedLines: PurchaseLineDraft[] = [];
  const taxCodeByRate = new Map<string, string>();
  for (const line of lines) {
    const rate = line.tax_rate ?? '0';
    const taxType = line.tax_type ?? 'VAT';
    const key = `${rate}|${taxType}`;
    let taxCodeId = taxCodeByRate.get(key);
    if (!taxCodeId) {
      const found = await client.query(
        `SELECT id FROM tax_codes
         WHERE tenant_id = $1 AND rate = $2 AND type = $3 AND is_active
           AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date)
         ORDER BY CASE
           WHEN reporting_mapping = 'DOMESTIC_INPUT_VAT' THEN 0
           WHEN reporting_mapping = 'REVERSE_CHARGE' THEN 1
           WHEN reporting_mapping = 'CONSTRUCTION_RC' THEN 2
           ELSE 3
         END, effective_from DESC LIMIT 1`,
        [tenantId, rate, taxType === 'REVERSE_CHARGE' ? 'REVERSE_CHARGE' : 'VAT', invoiceDate],
      );
      if (found.rows[0]) {
        taxCodeId = String(found.rows[0].id);
        taxCodeByRate.set(key, taxCodeId);
      }
    }
    const expenseAccountId = settings.default_expense_account_id ?? '';
    convertedLines.push({ ...line, tax_code_id: taxCodeId ?? '', expense_account_id: expenseAccountId });
  }
  const validated = await validateLines(client, tenantId, invoiceDate, convertedLines, settings.default_expense_account_id);
  const totals = totalsOf(validated);
  const snapshot = supplierId
    ? await client.query('SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2', [supplierId, tenantId])
    : null;
  const inserted = await client.query(
    `INSERT INTO purchase_invoices
       (tenant_id, company_id, supplier_id, status, supplier_invoice_number,
        supplier_invoice_number_normalized, invoice_date, due_date, currency_code,
        supplier_reference, supplier_iban, source_type, source_external_id,
        supplier_snapshot, source_total, subtotal, tax_total, total, created_by)
     VALUES ($1, $2, $3, 'INGESTED', $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      tenantId,
      settings.company_id ?? null,
      supplierId,
      canonical.invoiceNumber,
      normalized || null,
      invoiceDate,
      dueDate,
      currency,
      canonical.supplierReference || null,
      canonical.supplier.iban || canonical.supplierReference || null,
      sourceType,
      canonical.sourceExternalId,
      snapshot?.rows[0] ? JSON.stringify(supplierSnapshot(snapshot.rows[0])) : '{}',
      canonical.total ?? null,
      totals.subtotal,
      totals.taxTotal,
      totals.total,
      userId,
    ],
  );
  const purchaseId = String(inserted.rows[0].id);
  await insertPurchaseLines(client, tenantId, purchaseId, validated);
  const extractionFields: Array<[string, string, number | null, string]> = [
    ['supplier_name', canonical.supplier.name, 1, 'STRUCTURED_XML'],
    ['invoice_number', canonical.invoiceNumber, 1, 'STRUCTURED_XML'],
    ['invoice_date', canonical.invoiceDate, 1, 'STRUCTURED_XML'],
    ['due_date', canonical.dueDate ?? '', 1, 'STRUCTURED_XML'],
    ['total', canonical.total ?? totals.total, 1, 'STRUCTURED_XML'],
    ['vat_total', canonical.taxTotal ?? totals.taxTotal, 1, 'STRUCTURED_XML'],
    ['currency', currency, 1, 'STRUCTURED_XML'],
    ['supplier_business_id', canonical.supplier.businessId, 1, 'STRUCTURED_XML'],
    ['supplier_vat_id', canonical.supplier.vatId, 1, 'STRUCTURED_XML'],
    ['iban', canonical.supplier.iban, 1, 'STRUCTURED_XML'],
    ['reference', canonical.paymentReference, 1, 'STRUCTURED_XML'],
  ];
  for (const [field, value, confidence, source] of extractionFields) {
    if (!value) continue;
    await client.query(
      `INSERT INTO purchase_invoice_extractions
         (tenant_id, purchase_invoice_id, field_name, value, confidence, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, purchaseId, field, String(value), confidence, source],
    );
  }
  await client.query(
    `UPDATE purchase_invoices SET status = 'NEEDS_REVIEW', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'INGESTED'`,
    [purchaseId, tenantId],
  );
  await client.query(
    `INSERT INTO purchase_imports
       (tenant_id, source_type, source_external_id, supplier_name, supplier_invoice_number,
        total, status, purchase_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'PROCESSED', $7)
     ON CONFLICT (tenant_id, source_type, source_external_id) DO UPDATE
       SET status = 'PROCESSED', purchase_invoice_id = EXCLUDED.purchase_invoice_id, updated_at = now()`,
    [tenantId, sourceType, canonical.sourceExternalId, canonical.supplier.name, canonical.invoiceNumber, totals.total, purchaseId],
  );
  await recordApproval(client, tenantId, purchaseId, 'INGESTED', userId, `source ${sourceType}`);
  return getPurchaseById(client, tenantId, purchaseId);
}

export async function importEinvoice(
  pool: Db,
  tenantId: string,
  userId: string,
  input: { format: EinvoiceFormat; content: string; externalId?: string },
): Promise<{ purchase: any; duplicate: boolean }> {
  const canonical: CanonicalPurchaseInvoice = parseEinvoice(input.format, input.content);
  const sourceType = input.format;
  const sourceExternalId = input.externalId ?? canonical.sourceExternalId ?? `${input.format}:${canonical.invoiceNumber}`;
  const duplicate = await withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await client.query(
      `SELECT id FROM purchase_invoices
       WHERE tenant_id = $1 AND source_type = $2 AND source_external_id = $3`,
      [tenantId, sourceType, sourceExternalId],
    );
    return existing.rows[0] ? String(existing.rows[0].id) : null;
  });
  if (duplicate) {
    const existing = await getPurchase(pool, tenantId, duplicate);
    return { purchase: existing, duplicate: true };
  }
  try {
    const purchase = await withTenantTransaction(pool, tenantId, (client) =>
      createFromCanonical(client, tenantId, userId, { ...canonical, sourceExternalId }, sourceType),
    );
    return { purchase, duplicate: false };
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      const existingAfterRace = await withTenantTransaction(pool, tenantId, async (client) => {
        const rows = await client.query(
          `SELECT id FROM purchase_invoices
           WHERE tenant_id = $1 AND source_type = $2 AND source_external_id = $3`,
          [tenantId, sourceType, sourceExternalId],
        );
        return rows.rows[0] ? String(rows.rows[0].id) : null;
      });
      if (existingAfterRace) {
        const existing = await getPurchase(pool, tenantId, existingAfterRace);
        return { purchase: existing, duplicate: true };
      }
      throw new AppError(ErrorCodes.duplicatePurchase, 'Duplicate supplier invoice', 409);
    }
    throw error;
  }
}

export async function listPurchaseImports(pool: Db, tenantId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM purchase_imports WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [tenantId],
    );
    return result.rows.map(normalizeRow);
  });
}

export async function cancelPurchaseDraft(
  pool: Db,
  tenantId: string,
  purchaseId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await lockPurchase(client, tenantId, purchaseId);
    if (String(existing.status) !== 'DRAFT') {
      throw new AppError(ErrorCodes.purchaseNotEditable, 'Only drafts can be cancelled', 409);
    }
    await client.query(
      `UPDATE purchase_invoices SET status = 'CANCELLED_DRAFT', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'`,
      [purchaseId, tenantId],
    );
    return getPurchaseById(client, tenantId, purchaseId);
  });
}

export async function runPurchaseOcr(
  pool: Db,
  tenantId: string,
  userId: string,
  purchaseId: string,
  provider: DocumentOcrProvider,
  storage: LocalObjectStorageProvider,
): Promise<any> {
  const source = await withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2`,
      [purchaseId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase document not found', 404);
    const status = String(invoice.rows[0].status);
    if (!['DRAFT', 'INGESTED', 'NEEDS_REVIEW'].includes(status)) {
      throw new AppError(ErrorCodes.purchaseImmutable, 'OCR is only available on editable purchase documents', 409);
    }
    const docs = await client.query(
      `SELECT pid.document_id
       FROM purchase_invoice_documents pid
       WHERE pid.purchase_invoice_id = $1 AND pid.tenant_id = $2 AND pid.role = 'SOURCE'
       ORDER BY pid.created_at DESC LIMIT 1`,
      [purchaseId, tenantId],
    );
    if (!docs.rows[0]) throw new AppError(ErrorCodes.invalidSourceDocument, 'Upload a source document first', 400);
    await client.query(
      `UPDATE purchase_invoices
       SET ocr_status = 'PROCESSING', ocr_provider = $3, ocr_error = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [purchaseId, tenantId, provider.name],
    );
    return { documentId: String(docs.rows[0].document_id), invoice: invoice.rows[0] };
  });

  const download = await getDocumentDownload(pool, tenantId, source.documentId);
  const data = await storage.get(download.storageKey);
  let result: OcrResult;
  try {
    result = await provider.extract({
      originalFilename: download.filename,
      mimeType: download.mimeType,
      data,
    });
  } catch (error) {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE purchase_invoices
         SET ocr_status = 'FAILED', ocr_error = $3, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [purchaseId, tenantId, error instanceof Error ? error.message.slice(0, 500) : 'OCR failed'],
      );
    });
    throw new AppError(ErrorCodes.extractionFailed, 'OCR could not extract the document', 422);
  }

  await withTenantTransaction(pool, tenantId, async (client) => {
    const current = await client.query(
      `SELECT status FROM purchase_invoices WHERE id = $1 AND tenant_id = $2`,
      [purchaseId, tenantId],
    );
    if (!current.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase document not found', 404);
    const settings = await ensurePurchaseSettingsRow(client, tenantId);
    const fieldValues: Array<[string, string | null | undefined, number | null | undefined]> = [
      ['supplier_name', result.supplierName, result.confidence.supplier_name ?? null],
      ['business_id', result.businessId, null],
      ['vat_id', result.vatNumber, null],
      ['document_number', result.documentNumber, result.confidence.document_number ?? null],
      ['invoice_date', result.date, result.confidence.date ?? null],
      ['due_date', result.dueDate, null],
      ['total', result.total, result.confidence.total ?? null],
      ['net', result.net, null],
      ['vat_total', result.vatTotal, null],
      ['iban', result.iban, null],
      ['reference', result.reference, null],
      ['currency', result.currency, null],
      ['payment_method', result.paymentMethod, null],
      ['description', result.description, null],
      ['raw_ocr_metadata', result.rawMetadata ? JSON.stringify(result.rawMetadata) : null, null],
    ];
    for (const [field, value, confidence] of fieldValues) {
      if (!value) continue;
      await client.query(
        `INSERT INTO purchase_invoice_extractions
           (tenant_id, purchase_invoice_id, field_name, value, confidence, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, purchase_invoice_id, field_name, source) DO NOTHING`,
        [tenantId, purchaseId, field, String(value), confidence, `OCR:${provider.name}`],
      );
    }
    let matchedSupplierId: string | null = null;
    if (!current.rows[0].supplier_id) {
      const signals: Array<[string, string]> = [];
      if (result.businessId) signals.push(['business_id', result.businessId]);
      if (result.vatNumber) signals.push(['vat_id', result.vatNumber]);
      if (result.supplierName) signals.push(['name', result.supplierName]);
      for (const [column, value] of signals) {
        const candidates = await client.query(
          `SELECT id FROM business_parties
           WHERE tenant_id = $1 AND is_supplier AND lower(${column}) = lower($2)
           LIMIT 2`,
          [tenantId, value],
        );
        if (candidates.rows.length === 1) {
          matchedSupplierId = String(candidates.rows[0].id);
          break;
        }
        if (candidates.rows.length > 1) {
          matchedSupplierId = null;
          break;
        }
      }
    }
    const lineInputs: PurchaseLineDraft[] = [];
    const ocrLines = result.lines.length > 0 ? result.lines : [{ description: result.description ?? 'Extracted expense', netAmount: result.net ?? result.total }];
    const taxByRate = new Map<string, string>();
    for (const line of ocrLines) {
      const rate = line.taxRate ?? '0';
      const taxType = line.taxType ?? 'VAT';
      const key = `${rate}|${taxType}`;
      let taxCodeId = taxByRate.get(key);
      if (!taxCodeId) {
        const found = await client.query(
          `SELECT id FROM tax_codes
           WHERE tenant_id = $1 AND rate = $2 AND is_active
             AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)
           ORDER BY CASE WHEN reporting_mapping = 'DOMESTIC_INPUT_VAT' THEN 0 ELSE 1 END
           LIMIT 1`,
          [tenantId, rate, result.date ?? new Date().toISOString().slice(0, 10)],
        );
        if (found.rows[0]) {
          taxCodeId = String(found.rows[0].id);
          taxByRate.set(key, taxCodeId);
        }
      }
      lineInputs.push({
        description: line.description ?? 'Extracted line',
        quantity: line.quantity ?? null,
        unit: line.unit ?? null,
        unit_price: line.unitPrice ?? null,
        net_amount: line.netAmount ?? null,
        tax_code_id: taxCodeId ?? '',
        tax_rate: rate,
        tax_type: taxType,
        expense_account_id: settings.default_expense_account_id ?? '',
      });
    }
    const validated = await validateLines(
      client,
      tenantId,
      result.date ?? source.invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
      lineInputs,
      settings.default_expense_account_id,
    );
    await client.query(
      `UPDATE purchase_invoices
       SET invoice_date = COALESCE($3::date, invoice_date),
           due_date = COALESCE($4::date, due_date),
           supplier_invoice_number = COALESCE($5, supplier_invoice_number),
           supplier_id = COALESCE($6, supplier_id),
           supplier_snapshot = CASE WHEN $6 IS NOT NULL THEN $7::jsonb ELSE supplier_snapshot END,
           merchant_name = CASE WHEN supplier_id IS NULL AND merchant_name IS NULL THEN $8 ELSE merchant_name END,
           ocr_status = 'COMPLETE', ocr_provider = $9, ocr_error = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        purchaseId,
        tenantId,
        result.date ?? null,
        result.dueDate ?? null,
        result.documentNumber ?? null,
        matchedSupplierId,
        matchedSupplierId
          ? JSON.stringify({ name: result.supplierName ?? matchedSupplierId, matched_from_ocr: true })
          : null,
        result.supplierName ?? null,
        provider.name,
      ],
    );
    await client.query('DELETE FROM purchase_invoice_lines WHERE purchase_invoice_id = $1 AND tenant_id = $2', [
      purchaseId,
      tenantId,
    ]);
    await insertPurchaseLines(client, tenantId, purchaseId, validated);
    const recomputed = totalsOf(validated);
    await client.query(
      `UPDATE purchase_invoices
       SET subtotal = $3, tax_total = $4, total = $5, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [purchaseId, tenantId, recomputed.subtotal, recomputed.taxTotal, recomputed.total],
    );
    const updated = await client.query(
      `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2`,
      [purchaseId, tenantId],
    );
    if (updated.rows[0]) {
      const warning = await detectDuplicateWarning(client, tenantId, updated.rows[0]);
      await client.query(
        `UPDATE purchase_invoices SET duplicate_warning = $3, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [purchaseId, tenantId, warning],
      );
    }
  });
  return getPurchase(pool, tenantId, purchaseId);
}

export async function attachPurchaseDocument(
  pool: Db,
  tenantId: string,
  userId: string,
  purchaseId: string,
  storage: LocalObjectStorageProvider,
  input: { originalFilename: string; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png'; data: Buffer; role?: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const purchase = await lockPurchase(client, tenantId, purchaseId);
    if (['POSTED', 'CORRECTED', 'REJECTED', 'CANCELLED_DRAFT'].includes(String(purchase.status))) {
      throw new AppError(ErrorCodes.purchaseImmutable, 'Documents cannot be attached to a terminal purchase invoice', 409);
    }
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'] as const;
    if (!allowedTypes.includes(input.mimeType as any)) {
      throw new AppError(ErrorCodes.invalidSourceDocument, 'Only PDF, JPEG and PNG are supported', 415);
    }
    const existingSource = await client.query(
      `SELECT id FROM purchase_invoice_documents
       WHERE tenant_id = $1 AND purchase_invoice_id = $2 AND role = 'SOURCE'`,
      [tenantId, purchaseId],
    );
    const role = existingSource.rows[0] ? 'ATTACHMENT' : (input.role ?? 'SOURCE');
    // uploadDocument opens its own transaction; do it outside the purchase tx.
    const document = await uploadDocument(pool, tenantId, userId, storage, {
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      data: input.data,
      documentType: 'PURCHASE_INVOICE',
    });
    await client.query(
      `INSERT INTO purchase_invoice_documents
         (tenant_id, purchase_invoice_id, document_id, document_version_id, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, purchase_invoice_id, document_version_id, role) DO NOTHING`,
      [tenantId, purchaseId, document.id, document.latest_version_id, role],
    );
    return { document, role };
  });
}

export async function listPurchaseDocuments(pool: Db, tenantId: string, purchaseId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const purchase = await client.query(
      'SELECT id FROM purchase_invoices WHERE id = $1 AND tenant_id = $2',
      [purchaseId, tenantId],
    );
    if (!purchase.rows[0]) throw new AppError(ErrorCodes.purchaseNotFound, 'Purchase invoice not found', 404);
    const result = await client.query(
      `SELECT pid.role, pid.created_at, d.id AS document_id, dv.id AS document_version_id,
              dv.original_filename, dv.mime_type, dv.sha256, dv.size_bytes
       FROM purchase_invoice_documents pid
       JOIN documents d ON d.id = pid.document_id AND d.tenant_id = pid.tenant_id
       JOIN document_versions dv ON dv.id = pid.document_version_id AND dv.tenant_id = pid.tenant_id
       WHERE pid.purchase_invoice_id = $1 AND pid.tenant_id = $2
       ORDER BY pid.created_at`,
      [purchaseId, tenantId],
    );
    return result.rows;
  });
}
