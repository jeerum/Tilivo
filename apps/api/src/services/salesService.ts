import Decimal from 'decimal.js';
import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { generatePaymentReference, type PaymentReferenceType } from '../lib/paymentReferences';
import { withTenantTransaction } from './tenantService';
import { createJournalDraftInTransaction, postJournalEntryInTransaction } from './accountingService';
import { appendOutboxInTransaction } from './integrationQueue';
import type { RegistryCompany } from './businessRegistryTypes';
import {
  calculateVat,
  isTaxDirectionAllowed,
  TAX_TREATMENTS,
  type TaxCodeLike,
} from './vatEngineService';
import {
  allocateInvoiceDiscount,
  agingBucketLabel,
  agingBucketFor,
  calculateLateInterest,
  openBalance,
  paymentStatusFor,
  recurringNextRun,
  type DeliveryMethod,
} from './salesMath';

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CREDITED' | 'CANCELLED_DRAFT';
export type PdfStatus = 'GENERATING' | 'READY' | 'FAILED';

export const MONEY_DP = 8;
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const cents = (value: Decimal | string | number): Decimal =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface InvoiceLineDraftInput {
  description: string;
  quantity: string;
  unit?: string;
  unit_price: string;
  discount_percent?: string;
  tax_code_id: string;
  revenue_account_id?: string | null;
}

export interface InvoiceDraftInput {
  customer_id: string;
  series_id?: string;
  issue_date?: string;
  due_date?: string;
  currency_code?: string;
  language?: string;
  reference_type?: PaymentReferenceType;
  document_type?: 'SALES_INVOICE' | 'ADVANCE_INVOICE';
  discount_percent?: string;
  discount_amount?: string;
  delivery_method?: DeliveryMethod;
  customer_po_number?: string | null;
  customer_reference?: string | null;
  lines: InvoiceLineDraftInput[];
}

export interface CustomerInput {
  name: string;
  is_customer?: boolean;
  is_supplier?: boolean;
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
  e_invoice_ovt?: string | null;
  delivery_method?: DeliveryMethod;
  reminder_fee_amount?: string | null;
  late_interest_enabled?: boolean;
  late_interest_rate?: string | number;
  late_interest_grace_days?: number;
  registry_source?: string | null;
  registry_source_id?: string | null;
  registry_fetched_at?: string | null;
  registry_snapshot?: RegistryCompany | null;
}

export interface SeriesInput {
  name: string;
  prefix?: string;
  fiscal_year_id?: string | null;
  is_active?: boolean;
}

export interface SalesSettingsPatch {
  default_invoice_series_id?: string | null;
  default_payment_terms_days?: number;
  accounts_receivable_account_id?: string | null;
  default_sales_revenue_account_id?: string | null;
  tax_payable_account_id?: string | null;
  default_language?: string;
  default_currency?: string;
  payment_reference_type?: PaymentReferenceType;
  bank_iban?: string | null;
  bank_bic?: string | null;
  bank_account_holder?: string | null;
  advance_payments_received_account_id?: string | null;
  default_delivery_method?: DeliveryMethod;
  reminder_fee_enabled?: boolean;
  reminder_fee_amount?: string | null;
  late_interest_enabled?: boolean;
  late_interest_rate?: string | number;
  late_interest_grace_days?: number;
}

const today = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function toDateString(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return raw.slice(0, 10);
}

function normalizeDateFields(row: any): any {
  if (!row) return row;
  for (const key of ['issue_date', 'due_date', 'posted_at', 'issued_at', 'created_at', 'updated_at']) {
    if (row[key] !== undefined && row[key] !== null && !(typeof row[key] === 'string')) {
      row[key] = toDateString(row[key]);
    }
  }
  for (const key of [
    'subtotal',
    'tax_total',
    'total',
    'net_amount',
    'tax_amount',
    'gross_amount',
    'unit_price',
    'discount_percent',
    'discount_amount',
    'credited_amount',
    'advance_applied',
    'amount_paid',
  ]) {
    if (row[key] === undefined || row[key] === null || row[key] === '') continue;
    const numeric = Number(row[key]);
    if (Number.isFinite(numeric)) row[key] = numeric.toFixed(2);
  }
  return row;
}

async function ensureSalesSettingsRow(client: DbClient, tenantId: string): Promise<any> {
  const existing = await client.query(
    'SELECT * FROM sales_settings WHERE tenant_id = $1 LIMIT 1',
    [tenantId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const seriesResult = await client.query(
    `INSERT INTO invoice_number_series (tenant_id, name, prefix)
     VALUES ($1, 'Default', '')
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id`,
    [tenantId],
  );
  let seriesId = seriesResult.rows[0]?.id;
  if (!seriesId) {
    const fallback = await client.query(
      `SELECT id FROM invoice_number_series
       WHERE tenant_id = $1 AND name = 'Default'`,
      [tenantId],
    );
    seriesId = fallback.rows[0]?.id;
  }
  if (!seriesId) {
    throw new AppError(ErrorCodes.numberSeriesNotFound, 'Could not create a default number series', 500);
  }
  const company = await client.query(
    `SELECT id FROM companies
     WHERE tenant_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  const settings = await client.query(
    `INSERT INTO sales_settings
       (tenant_id, company_id, default_invoice_series_id, default_payment_terms_days,
        default_language, default_currency, payment_reference_type)
     VALUES ($1, $2, $3, 14, 'fi', 'EUR', 'FI_DOMESTIC')
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING *`,
    [tenantId, company.rows[0]?.id ?? null, seriesId],
  );
  if (settings.rows[0]) return settings.rows[0];
  const secondRead = await client.query(
    'SELECT * FROM sales_settings WHERE tenant_id = $1 LIMIT 1',
    [tenantId],
  );
  if (!secondRead.rows[0]) {
    throw new AppError(ErrorCodes.accountMappingMissing, 'Sales settings could not be initialized', 500);
  }
  return secondRead.rows[0];
}

async function resolveCompanyId(client: DbClient, tenantId: string, settingsCompanyId: string | null): Promise<string | null> {
  if (settingsCompanyId) {
    const exists = await client.query(
      'SELECT id FROM companies WHERE id = $1 AND tenant_id = $2',
      [settingsCompanyId, tenantId],
    );
    if (exists.rows[0]) return settingsCompanyId;
  }
  const company = await client.query(
    `SELECT id FROM companies
     WHERE tenant_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  return company.rows[0]?.id ? String(company.rows[0].id) : null;
}

async function resolveSeries(
  client: DbClient,
  tenantId: string,
  settings: any,
  requestedSeriesId?: string,
): Promise<any> {
  const requested = requestedSeriesId ?? settings.default_invoice_series_id;
  if (!requested) {
    const active = await client.query(
      `SELECT * FROM invoice_number_series
       WHERE tenant_id = $1 AND is_active
       ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    if (!active.rows[0]) {
      const created = await client.query(
        `INSERT INTO invoice_number_series (tenant_id, name, prefix)
         VALUES ($1, 'Default', '')
         ON CONFLICT (tenant_id, name) DO NOTHING
         RETURNING *`,
        [tenantId],
      );
      if (!created.rows[0]) {
        const fallback = await client.query(
          `SELECT * FROM invoice_number_series WHERE tenant_id = $1 AND name = 'Default'`,
          [tenantId],
        );
        return fallback.rows[0];
      }
      return created.rows[0];
    }
    return active.rows[0];
  }
  const result = await client.query(
    `SELECT * FROM invoice_number_series
     WHERE id = $1 AND tenant_id = $2 AND is_active`,
    [requested, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(ErrorCodes.numberSeriesNotFound, 'Invoice number series not found or inactive', 404);
  return row;
}

async function validateCurrency(client: DbClient, code: string): Promise<void> {
  const result = await client.query(
    'SELECT code FROM currencies WHERE code = $1 AND is_active',
    [code],
  );
  if (!result.rows[0]) {
    throw new AppError(ErrorCodes.currencyInvalid, 'Currency is not active or does not exist', 400);
  }
}

async function loadTaxCodesForDate(
  client: DbClient,
  tenantId: string,
  taxCodeIds: string[],
  date: string,
): Promise<Map<string, any>> {
  if (taxCodeIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT id, code, name, rate, type, reporting_mapping, is_active,
            direction, treatment, reverse_charge, intra_eu, is_export, is_import,
            deductible_percent, legal_notes, is_system
     FROM tax_codes
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])
       AND is_active
       AND effective_from <= $3::date
       AND (effective_to IS NULL OR effective_to >= $3::date)`,
    [tenantId, taxCodeIds, date],
  );
  const map = new Map<string, any>();
  for (const row of result.rows) map.set(String(row.id), row);
  return map;
}

export interface ComputedLine {
  net: string;
  discount: string;
  tax: string;
  gross: string;
  taxRate: string;
  taxType: string;
  reportingMapping: string | null;
  revenueAccountId: string;
  taxCodeId: string;
  taxCodeSnapshot: string;
  treatment: string;
  classification: string;
  deductiblePercent: string;
  taxLegalNote: string;
}

/**
 * Deterministic line arithmetic, rounded to cents, calculated through the
 * VAT engine:
 *   base = quantity * unit_price
 *   discount = round2(base * discount_percent / 100)
 *   net = round2(base - discount)
 *   tax/gross follow the semantic tax treatment (engine).
 */
export function computeLineAmounts(input: {
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  netAmountOverride?: string;
  revenueAccountId: string;
  taxCode: TaxCodeLike;
  invoiceLanguage?: string | null;
}): ComputedLine {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.unitPrice);
  const base = cents(quantity.mul(unitPrice));
  const discountPercent = new Decimal(input.discountPercent ?? '0');
  const discount = cents(base.mul(discountPercent).div(100));
  const net = input.netAmountOverride !== undefined
    ? cents(new Decimal(input.netAmountOverride))
    : cents(base.minus(discount));
  const taxCode = input.taxCode;
  const treatment = taxCode.treatment ?? TAX_TREATMENTS.STANDARD;
  const calc = calculateVat({
    direction: 'SALES',
    treatment,
    rate: String(taxCode.rate),
    netAmount: net,
    legalNotes: taxCode.legal_notes,
    language: input.invoiceLanguage,
  });
  return {
    net: net.toFixed(2),
    discount: discount.toFixed(2),
    tax: calc.invoiceTaxAmount,
    gross: calc.grossAmount,
    taxRate: calc.rate,
    taxType: String(taxCode.type ?? 'VAT'),
    reportingMapping: taxCode.reporting_mapping ? String(taxCode.reporting_mapping) : null,
    revenueAccountId: input.revenueAccountId,
    taxCodeId: String(taxCode.id),
    taxCodeSnapshot: String(taxCode.code),
    treatment,
    classification: calc.classification,
    deductiblePercent: String(taxCode.deductible_percent ?? '100'),
    taxLegalNote: calc.legalNote,
  };
}

async function validateInvoiceLines(
  client: DbClient,
  tenantId: string,
  input: InvoiceDraftInput,
  settings: any,
  issueDate: string,
  language?: string | null,
): Promise<ComputedLine[]> {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AppError(ErrorCodes.invoiceHasNoLines, 'Invoice requires at least one line', 400);
  }
  if (input.lines.length > 200) {
    throw new AppError(ErrorCodes.invalidInvoiceLine, 'Invoice cannot have more than 200 lines', 400);
  }
  const taxCodeIds = [...new Set(input.lines.map((line) => line.tax_code_id))];
  const taxMap = await loadTaxCodesForDate(client, tenantId, taxCodeIds, issueDate);
  const revenueAccountIds = [
    ...new Set(
      input.lines.map((line) => line.revenue_account_id ?? settings.default_sales_revenue_account_id),
    ),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const accounts = await client.query(
    `SELECT id FROM accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, revenueAccountIds],
  );
  const accountSet = new Set(accounts.rows.map((row: any) => String(row.id)));

  const results: ComputedLine[] = [];
  for (const line of input.lines) {
    const description = String(line.description ?? '').trim();
    if (!description) throw new AppError(ErrorCodes.invalidInvoiceLine, 'Line description is required', 400);
    const quantity = new Decimal(String(line.quantity));
    const unitPrice = new Decimal(String(line.unit_price));
    const discountPercent = new Decimal(String(line.discount_percent ?? '0'));
    if (!quantity.greaterThan(0) || quantity.greaterThan(1_000_000_000)) {
      throw new AppError(ErrorCodes.invalidInvoiceLine, 'Line quantity must be positive', 400);
    }
    if (unitPrice.lessThan(0) || unitPrice.greaterThan(1_000_000_000_000)) {
      throw new AppError(ErrorCodes.invalidInvoiceLine, 'Line unit price is invalid', 400);
    }
    if (discountPercent.lessThan(0) || discountPercent.greaterThan(100)) {
      throw new AppError(ErrorCodes.invalidInvoiceLine, 'Discount must be between 0 and 100 percent', 400);
    }
    const taxCode = taxMap.get(line.tax_code_id);
    if (!taxCode) {
      throw new AppError(
        ErrorCodes.invoiceTaxCodeInvalid,
        'Tax code is not active for the invoice date',
        400,
      );
    }
    if (!isTaxDirectionAllowed(String(taxCode.direction ?? 'BOTH') as any, 'SALES')) {
      throw new AppError(
        ErrorCodes.taxCodeDirectionIncompatible,
        'Tax code is not valid for sales invoices',
        400,
      );
    }
    const revenueAccountId = line.revenue_account_id ?? settings.default_sales_revenue_account_id;
    if (!revenueAccountId || !accountSet.has(String(revenueAccountId))) {
      throw new AppError(
        ErrorCodes.invalidInvoiceLine,
        'Revenue account is missing or outside the tenant',
        400,
      );
    }
    results.push(
      computeLineAmounts({
        quantity: quantity.toString(),
        unitPrice: unitPrice.toString(),
        discountPercent: discountPercent.toString(),
        revenueAccountId: String(revenueAccountId),
        taxCode,
        invoiceLanguage: language ?? input.language,
      }),
    );
  }
  return results;
}

function totalsFor(computed: ComputedLine[]): { subtotal: string; taxTotal: string; total: string } {
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (const line of computed) {
    subtotal = subtotal.plus(new Decimal(line.net));
    taxTotal = taxTotal.plus(new Decimal(line.tax));
  }
  return {
    subtotal: subtotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: subtotal.plus(taxTotal).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function listCustomers(
  pool: Db,
  tenantId: string,
  filters: { search?: string; active?: boolean; limit?: number; offset?: number } = {},
): Promise<{ customers: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(
        `(name ILIKE $${values.length} OR business_id ILIKE $${values.length}
          OR vat_id ILIKE $${values.length} OR email ILIKE $${values.length})`,
      );
    }
    if (filters.active !== undefined) {
      values.push(filters.active);
      clauses.push(`is_active = $${values.length}`);
    }
    const where = `WHERE tenant_id = $1${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
    const total = await client.query(`SELECT count(*)::int AS total FROM business_parties ${where}`, values);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = await client.query(
      `SELECT * FROM business_parties ${where}
       ORDER BY name, created_at
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return { customers: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
  });
}

export async function getCustomer(pool: Db, tenantId: string, customerId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_customer',
      [customerId, tenantId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    return result.rows[0];
  });
}

export async function createCustomer(
  pool: Db,
  tenantId: string,
  userId: string,
  input: CustomerInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 300) {
      throw new AppError(ErrorCodes.invalidCustomer, 'Customer name is required', 400);
    }
    const country = String(input.country_code ?? 'FI').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new AppError(ErrorCodes.invalidCustomer, 'Country code must be two letters', 400);
    }
    const currency = String(input.default_currency ?? 'EUR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new AppError(ErrorCodes.currencyInvalid, 'Currency code must be three letters', 400);
    }
    await validateCurrency(client, currency);
    const result = await client.query(
      `INSERT INTO business_parties
         (tenant_id, name, is_customer, is_supplier, business_id, vat_id, email, phone,
          address_line1, address_line2, postal_code, city, country_code, language,
          payment_terms_days, default_currency, iban, e_invoice_address, e_invoice_operator,
          registry_source, registry_source_id, registry_fetched_at, registry_snapshot,
          is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, true)
       RETURNING *`,
      [
        tenantId,
        name,
        input.is_customer ?? true,
        input.is_supplier ?? false,
        input.business_id || null,
        input.vat_id || null,
        input.email || null,
        input.phone || null,
        input.address_line1 || null,
        input.address_line2 || null,
        input.postal_code || null,
        input.city || null,
        country,
        String(input.language ?? 'fi').toLowerCase(),
        Number.isInteger(input.payment_terms_days) && input.payment_terms_days! >= 0
          ? input.payment_terms_days
          : 14,
        currency,
        input.iban || null,
        input.e_invoice_address || null,
        input.e_invoice_operator || null,
        input.registry_source || null,
        input.registry_source_id || null,
        input.registry_fetched_at || null,
        input.registry_snapshot ? JSON.stringify(input.registry_snapshot) : null,
      ],
    );
    return result.rows[0];
  });
}

export async function updateCustomer(
  pool: Db,
  tenantId: string,
  customerId: string,
  patch: Partial<CustomerInput>,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const current = await client.query(
      'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId],
    );
    if (!current.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    const existing = current.rows[0];
    const name = patch.name !== undefined ? String(patch.name).trim() : String(existing.name);
    if (!name) throw new AppError(ErrorCodes.invalidCustomer, 'Customer name is required', 400);
    const country = (patch.country_code ?? existing.country_code).toUpperCase();
    const currency = (patch.default_currency ?? existing.default_currency).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new AppError(ErrorCodes.invalidCustomer, 'Country code must be two letters', 400);
    if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(ErrorCodes.currencyInvalid, 'Currency code must be three letters', 400);
    await validateCurrency(client, currency);
    const result = await client.query(
      `UPDATE business_parties
       SET name = $3,
           is_customer = $4,
           is_supplier = $5,
           business_id = $6,
           vat_id = $7,
           email = $8,
           phone = $9,
           address_line1 = $10,
           address_line2 = $11,
           postal_code = $12,
           city = $13,
           country_code = $14,
           language = $15,
           payment_terms_days = $16,
           default_currency = $17,
           iban = $18,
           e_invoice_address = $19,
           e_invoice_operator = $20,
           registry_source = $21,
           registry_source_id = $22,
           registry_fetched_at = $23,
           registry_snapshot = $24,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [
        customerId,
        tenantId,
        name,
        patch.is_customer ?? existing.is_customer,
        patch.is_supplier ?? existing.is_supplier,
        patch.business_id === undefined ? existing.business_id : patch.business_id || null,
        patch.vat_id === undefined ? existing.vat_id : patch.vat_id || null,
        patch.email === undefined ? existing.email : patch.email || null,
        patch.phone === undefined ? existing.phone : patch.phone || null,
        patch.address_line1 === undefined ? existing.address_line1 : patch.address_line1 || null,
        patch.address_line2 === undefined ? existing.address_line2 : patch.address_line2 || null,
        patch.postal_code === undefined ? existing.postal_code : patch.postal_code || null,
        patch.city === undefined ? existing.city : patch.city || null,
        country,
        (patch.language ?? existing.language).toLowerCase(),
        patch.payment_terms_days !== undefined ? patch.payment_terms_days : existing.payment_terms_days,
        currency,
        patch.iban === undefined ? existing.iban : patch.iban || null,
        patch.e_invoice_address === undefined ? existing.e_invoice_address : patch.e_invoice_address || null,
        patch.e_invoice_operator === undefined ? existing.e_invoice_operator : patch.e_invoice_operator || null,
        patch.registry_source === undefined ? existing.registry_source : patch.registry_source || null,
        patch.registry_source_id === undefined ? existing.registry_source_id : patch.registry_source_id || null,
        patch.registry_fetched_at === undefined
          ? existing.registry_fetched_at
          : patch.registry_fetched_at || null,
        patch.registry_snapshot === undefined
          ? existing.registry_snapshot
          : patch.registry_snapshot
            ? JSON.stringify(patch.registry_snapshot)
            : null,
      ],
    );
    return result.rows[0];
  });
}

export async function setCustomerActive(
  pool: Db,
  tenantId: string,
  customerId: string,
  active: boolean,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE business_parties SET is_active = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [customerId, tenantId, active],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    return result.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Number series + settings
// ---------------------------------------------------------------------------

export async function listSeries(pool: Db, tenantId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT s.*, (ss.default_invoice_series_id = s.id) AS is_default
       FROM invoice_number_series s
       LEFT JOIN sales_settings ss ON ss.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
       ORDER BY s.created_at`,
      [tenantId],
    );
    return result.rows;
  });
}

export async function createSeries(pool: Db, tenantId: string, input: SeriesInput): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 100) {
      throw new AppError(ErrorCodes.numberSeriesNotFound, 'Series name is required', 400);
    }
    try {
      const result = await client.query(
        `INSERT INTO invoice_number_series (tenant_id, name, prefix, fiscal_year_id, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          tenantId,
          name,
          String(input.prefix ?? '').trim().slice(0, 40),
          input.fiscal_year_id ?? null,
          input.is_active ?? true,
        ],
      );
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.numberSeriesNotFound, 'A series with this name already exists', 409);
      }
      if (pgError.code === '23503') {
        throw new AppError(ErrorCodes.numberSeriesNotFound, 'Fiscal year is outside the tenant', 400);
      }
      throw error;
    }
  });
}

export async function updateSeries(
  pool: Db,
  tenantId: string,
  seriesId: string,
  patch: Partial<SeriesInput>,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [seriesId, tenantId];
    if (patch.name !== undefined) {
      values.push(String(patch.name).trim());
      sets.push(`name = $${values.length}`);
    }
    if (patch.prefix !== undefined) {
      values.push(String(patch.prefix).trim().slice(0, 40));
      sets.push(`prefix = $${values.length}`);
    }
    if (patch.is_active !== undefined) {
      values.push(patch.is_active);
      sets.push(`is_active = $${values.length}`);
    }
    if (patch.fiscal_year_id !== undefined) {
      values.push(patch.fiscal_year_id || null);
      sets.push(`fiscal_year_id = $${values.length}`);
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.numberSeriesNotFound, 'No series fields to update', 400);
    sets.push('updated_at = now()');
    try {
      const result = await client.query(
        `UPDATE invoice_number_series SET ${sets.join(', ')}
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        values,
      );
      if (!result.rows[0]) throw new AppError(ErrorCodes.numberSeriesNotFound, 'Series not found', 404);
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.numberSeriesNotFound, 'A series with this name already exists', 409);
      }
      if (pgError.code === '23503') {
        throw new AppError(ErrorCodes.numberSeriesNotFound, 'Fiscal year is outside the tenant', 400);
      }
      throw error;
    }
  });
}

export async function getSalesSettings(pool: Db, tenantId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const settings = await ensureSalesSettingsRow(client, tenantId);
    return settings;
  });
}

export async function updateSalesSettings(
  pool: Db,
  tenantId: string,
  patch: SalesSettingsPatch,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const settings = await ensureSalesSettingsRow(client, tenantId);
    const sets: string[] = [];
    const values: unknown[] = [tenantId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.default_invoice_series_id !== undefined) {
      if (patch.default_invoice_series_id) {
        const series = await client.query(
          `SELECT id FROM invoice_number_series WHERE id = $1 AND tenant_id = $2 AND is_active`,
          [patch.default_invoice_series_id, tenantId],
        );
        if (!series.rows[0]) {
          throw new AppError(ErrorCodes.numberSeriesNotFound, 'Default series not found or inactive', 400);
        }
      }
      add('default_invoice_series_id', patch.default_invoice_series_id || null);
    }
    if (patch.default_payment_terms_days !== undefined) {
      if (!Number.isInteger(patch.default_payment_terms_days) || patch.default_payment_terms_days < 0) {
        throw new AppError(ErrorCodes.invalidDueDate, 'Payment terms must be a non-negative integer', 400);
      }
      add('default_payment_terms_days', patch.default_payment_terms_days);
    }
    const accountFields: Array<[string, string | null]> = [
      ['accounts_receivable_account_id', patch.accounts_receivable_account_id ?? null],
      ['default_sales_revenue_account_id', patch.default_sales_revenue_account_id ?? null],
      ['tax_payable_account_id', patch.tax_payable_account_id ?? null],
    ];
    const includeAccountPatch =
      patch.accounts_receivable_account_id !== undefined ||
      patch.default_sales_revenue_account_id !== undefined ||
      patch.tax_payable_account_id !== undefined;
    if (includeAccountPatch) {
      for (const [column, value] of accountFields) {
        if (value) {
          const account = await client.query(
            'SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2 AND is_active',
            [value, tenantId],
          );
          if (!account.rows[0]) {
            throw new AppError(ErrorCodes.accountMappingMissing, `${column} references an invalid account`, 400);
          }
        }
        add(column, value);
      }
    }
    if (patch.default_language !== undefined) {
      add('default_language', String(patch.default_language).toLowerCase().slice(0, 10) || 'fi');
    }
    if (patch.default_currency !== undefined) {
      const currency = String(patch.default_currency).toUpperCase();
      await validateCurrency(client, currency);
      add('default_currency', currency);
    }
    if (patch.payment_reference_type !== undefined) {
      if (!['FI_DOMESTIC', 'RF', 'NONE'].includes(patch.payment_reference_type)) {
        throw new AppError(ErrorCodes.referenceInvalid, 'Unsupported payment reference type', 400);
      }
      add('payment_reference_type', patch.payment_reference_type);
    }
    if (patch.advance_payments_received_account_id !== undefined) {
      const value = patch.advance_payments_received_account_id;
      if (value) {
        const account = await client.query(
          'SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2 AND is_active',
          [value, tenantId],
        );
        if (!account.rows[0]) {
          throw new AppError(ErrorCodes.accountMappingMissing, 'advance account references an invalid account', 400);
        }
      }
      add('advance_payments_received_account_id', value || null);
    }
    if (patch.bank_iban !== undefined) add('bank_iban', patch.bank_iban || null);
    if (patch.bank_bic !== undefined) add('bank_bic', patch.bank_bic || null);
    if (patch.bank_account_holder !== undefined) add('bank_account_holder', patch.bank_account_holder || null);
    if (patch.default_delivery_method !== undefined) {
      if (!['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER'].includes(String(patch.default_delivery_method))) {
        throw new AppError(ErrorCodes.invalidRequest, 'Invalid default delivery method', 400);
      }
      add('default_delivery_method', patch.default_delivery_method);
    }
    if (patch.reminder_fee_enabled !== undefined) add('reminder_fee_enabled', patch.reminder_fee_enabled);
    if (patch.reminder_fee_amount !== undefined) {
      const value = new Decimal(String(patch.reminder_fee_amount ?? '0'));
      if (value.lessThan(0)) throw new AppError(ErrorCodes.invalidRequest, 'Reminder fee must not be negative', 400);
      add('reminder_fee_amount', value.toFixed(2));
    }
    if (patch.late_interest_enabled !== undefined) add('late_interest_enabled', patch.late_interest_enabled);
    if (patch.late_interest_rate !== undefined) {
      const rate = new Decimal(String(patch.late_interest_rate ?? '0'));
      if (rate.lessThan(0) || rate.greaterThan(100)) {
        throw new AppError(ErrorCodes.invalidRequest, 'Late interest rate must be between 0 and 100', 400);
      }
      add('late_interest_rate', rate.toFixed(6));
    }
    if (patch.late_interest_grace_days !== undefined) {
      if (!Number.isInteger(patch.late_interest_grace_days) || patch.late_interest_grace_days < 0) {
        throw new AppError(ErrorCodes.invalidRequest, 'Grace days must be a non-negative integer', 400);
      }
      add('late_interest_grace_days', patch.late_interest_grace_days);
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'No sales settings fields to update', 400);
    sets.push('updated_at = now()');
    const result = await client.query(
      `UPDATE sales_settings SET ${sets.join(', ')}
       WHERE tenant_id = $1
       RETURNING *`,
      values,
    );
    return result.rows[0] ?? settings;
  });
}

// ---------------------------------------------------------------------------
// Invoice drafts and listing
// ---------------------------------------------------------------------------

async function insertInvoiceLines(
  client: DbClient,
  tenantId: string,
  invoiceId: string,
  lines: Array<InvoiceLineDraftInput & { taxCodeId: string; computed: ComputedLine }>,
): Promise<void> {
  let lineNumber = 1;
  for (const line of lines) {
    await client.query(
      `INSERT INTO sales_invoice_lines
         (tenant_id, sales_invoice_id, line_number, description, quantity, unit, unit_price,
          discount_percent, net_amount, tax_code_id, tax_rate_snapshot, tax_type_snapshot,
          reporting_mapping_snapshot, tax_amount, gross_amount, revenue_account_id,
          tax_code_snapshot, tax_treatment_snapshot, deductible_percent_snapshot, tax_legal_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        tenantId,
        invoiceId,
        lineNumber,
        String(line.description).trim(),
        line.quantity,
        String(line.unit ?? '').trim().slice(0, 40),
        line.unit_price,
        line.discount_percent ?? '0',
        line.computed.net,
        line.taxCodeId,
        line.computed.taxRate,
        line.computed.taxType,
        line.computed.reportingMapping,
        line.computed.tax,
        line.computed.gross,
        line.computed.revenueAccountId,
        line.computed.taxCodeSnapshot,
        line.computed.treatment,
        line.computed.deductiblePercent,
        line.computed.taxLegalNote,
      ],
    );
    lineNumber += 1;
  }
}

async function parseInvoiceDraftInput(
  client: DbClient,
  tenantId: string,
  input: InvoiceDraftInput,
): Promise<{
  customer: any;
  series: any;
  settings: any;
  companyId: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  language: string;
  referenceType: PaymentReferenceType;
  lines: Array<InvoiceLineDraftInput & { taxCodeId: string; computed: ComputedLine }>;
}> {
  const customer = await client.query(
    'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_customer',
    [input.customer_id, tenantId],
  );
  if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
  if (!customer.rows[0].is_active) throw new AppError(ErrorCodes.customerInactive, 'Customer is inactive', 409);
  const settings = await ensureSalesSettingsRow(client, tenantId);
  const series = await resolveSeries(client, tenantId, settings, input.series_id);
  const companyId = await resolveCompanyId(client, tenantId, settings.company_id ?? null);
  const issueDate = input.issue_date ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new AppError(ErrorCodes.invalidDueDate, 'Invalid invoice date', 400);
  }
  const currency = String(input.currency_code ?? settings.default_currency ?? customer.rows[0].default_currency ?? 'EUR')
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(ErrorCodes.currencyInvalid, 'Invalid currency code', 400);
  await validateCurrency(client, currency);
  const language = String(input.language ?? settings.default_language ?? customer.rows[0].language ?? 'fi')
    .toLowerCase()
    .slice(0, 10);
  if (!['fi', 'en', 'et'].includes(language)) {
    throw new AppError(ErrorCodes.invalidRequest, 'Invoice language must be fi, en or et', 400);
  }
  const referenceType = (input.reference_type ?? settings.payment_reference_type ?? 'FI_DOMESTIC') as PaymentReferenceType;
  if (!['FI_DOMESTIC', 'RF', 'NONE'].includes(referenceType)) {
    throw new AppError(ErrorCodes.referenceInvalid, 'Unsupported payment reference type', 400);
  }
  const paymentTerms =
    Number.isInteger(customer.rows[0].payment_terms_days)
      ? Number(customer.rows[0].payment_terms_days)
      : Number(settings.default_payment_terms_days ?? 14);
  const dueDate = input.due_date ?? addDays(issueDate, paymentTerms);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new AppError(ErrorCodes.invalidDueDate, 'Invalid due date', 400);
  }
  if (dueDate < issueDate) {
    throw new AppError(ErrorCodes.invalidDueDate, 'Due date must not be before the invoice date', 400);
  }
  const computed = await validateInvoiceLines(client, tenantId, input, settings, issueDate, language);
  const lines = input.lines.map((line, index) => ({
    ...line,
    taxCodeId: line.tax_code_id,
    computed: computed[index]!,
  }));
  return {
    customer: customer.rows[0],
    series,
    settings,
    companyId,
    issueDate,
    dueDate,
    currency,
    language,
    referenceType,
    lines,
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function createInvoiceDraft(
  pool: Db,
  tenantId: string,
  userId: string,
  input: InvoiceDraftInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const parsed = await parseInvoiceDraftInput(client, tenantId, input);
    const totals = totalsFor(parsed.lines.map((line) => line.computed));
    const documentType = input.document_type ?? 'SALES_INVOICE';
    if (!['SALES_INVOICE', 'ADVANCE_INVOICE'].includes(documentType)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid sales document type', 400);
    }
    const discountPercent = String(input.discount_percent ?? '0');
    const discountAmount = String(input.discount_amount ?? '0');
    const percentValue = new Decimal(discountPercent);
    const amountValue = new Decimal(discountAmount);
    if (
      percentValue.lessThan(0) || percentValue.greaterThan(100) || amountValue.lessThan(0)
      || (percentValue.greaterThan(0) && amountValue.greaterThan(0))
    ) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invoice discount is invalid (use percent or amount, not both)', 400);
    }
    const deliveryMethod = (input.delivery_method
      ?? parsed.customer.delivery_method
      ?? parsed.settings.default_delivery_method
      ?? 'EMAIL') as DeliveryMethod;
    if (!['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER'].includes(deliveryMethod)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid delivery method', 400);
    }
    const invoice = await client.query(
      `INSERT INTO sales_invoices
         (tenant_id, company_id, customer_id, status, series_id, issue_date, due_date,
          currency_code, language, reference_type, customer_snapshot, subtotal, tax_total,
          total, created_by, document_type, discount_percent, discount_amount,
          delivery_method, customer_po_number, customer_reference)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        tenantId,
        parsed.companyId,
        input.customer_id,
        parsed.series.id,
        parsed.issueDate,
        parsed.dueDate,
        parsed.currency,
        parsed.language,
        parsed.referenceType,
        {},
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        userId,
        documentType,
        discountPercent,
        discountAmount,
        deliveryMethod,
        input.customer_po_number ?? null,
        input.customer_reference ?? null,
      ],
    );
    const invoiceId = String(invoice.rows[0].id);
    await insertInvoiceLines(client, tenantId, invoiceId, parsed.lines);
    return getInvoiceById(client, tenantId, invoiceId);
  });
}

export async function updateInvoiceDraft(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  input: InvoiceDraftInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await lockInvoice(client, tenantId, invoiceId);
    if (existing.status !== 'DRAFT') {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'Only draft invoices can be updated', 409);
    }
    const parsed = await parseInvoiceDraftInput(client, tenantId, input);
    const totals = totalsFor(parsed.lines.map((line) => line.computed));
    const documentType = input.document_type ?? existing.document_type ?? 'SALES_INVOICE';
    if (!['SALES_INVOICE', 'ADVANCE_INVOICE'].includes(documentType)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid sales document type', 400);
    }
    const discountPercent = String(input.discount_percent ?? '0');
    const discountAmount = String(input.discount_amount ?? '0');
    const percentValue = new Decimal(discountPercent);
    const amountValue = new Decimal(discountAmount);
    if (
      percentValue.lessThan(0) || percentValue.greaterThan(100) || amountValue.lessThan(0)
      || (percentValue.greaterThan(0) && amountValue.greaterThan(0))
    ) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invoice discount is invalid (use percent or amount, not both)', 400);
    }
    const deliveryMethod = (input.delivery_method
      ?? parsed.customer.delivery_method
      ?? parsed.settings.default_delivery_method
      ?? 'EMAIL') as DeliveryMethod;
    if (!['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER'].includes(deliveryMethod)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid delivery method', 400);
    }
    await client.query(
      `UPDATE sales_invoices
       SET company_id = $3, customer_id = $4, series_id = $5, issue_date = $6,
           due_date = $7, currency_code = $8, language = $9, reference_type = $10,
           subtotal = $11, tax_total = $12, total = $13, document_type = $14,
           discount_percent = $15, discount_amount = $16, delivery_method = $17,
           customer_po_number = $18, customer_reference = $19, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
       RETURNING id`,
      [
        invoiceId,
        tenantId,
        parsed.companyId,
        input.customer_id,
        parsed.series.id,
        parsed.issueDate,
        parsed.dueDate,
        parsed.currency,
        parsed.language,
        parsed.referenceType,
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        documentType,
        discountPercent,
        discountAmount,
        deliveryMethod,
        input.customer_po_number ?? existing.customer_po_number ?? null,
        input.customer_reference ?? existing.customer_reference ?? null,
      ],
    );
    await client.query(
      'DELETE FROM sales_invoice_lines WHERE sales_invoice_id = $1 AND tenant_id = $2',
      [invoiceId, tenantId],
    );
    await insertInvoiceLines(client, tenantId, invoiceId, parsed.lines);
    return getInvoiceById(client, tenantId, invoiceId);
  });
}

export async function cancelInvoiceDraft(pool: Db, tenantId: string, invoiceId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await lockInvoice(client, tenantId, invoiceId);
    if (existing.status === 'CANCELLED_DRAFT') {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'Invoice is already cancelled', 409);
    }
    if (existing.status !== 'DRAFT') {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'Only draft invoices can be cancelled', 409);
    }
    await client.query(
      `UPDATE sales_invoices SET status = 'CANCELLED_DRAFT', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    return getInvoiceById(client, tenantId, invoiceId);
  });
}

async function lockInvoice(client: DbClient, tenantId: string, invoiceId: string): Promise<any> {
  const result = await client.query(
    `SELECT * FROM sales_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [invoiceId, tenantId],
  );
  if (!result.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
  return result.rows[0];
}

async function getInvoiceById(client: DbClient, tenantId: string, invoiceId: string): Promise<any> {
  const invoice = await client.query(
    'SELECT * FROM sales_invoices WHERE id = $1 AND tenant_id = $2',
    [invoiceId, tenantId],
  );
  if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
  return normalizeDateFields(invoice.rows[0]);
}

async function allocateInvoiceNumber(
  client: DbClient,
  tenantId: string,
  seriesId: string,
  issueDate: string,
): Promise<{ number: string; running: string; year: string }> {
  const series = await client.query(
    `SELECT s.id, s.prefix, s.fiscal_year_id,
            fy.start_date AS fy_start_date
     FROM invoice_number_series s
     LEFT JOIN fiscal_years fy ON fy.id = s.fiscal_year_id AND fy.tenant_id = s.tenant_id
     WHERE s.id = $1 AND s.tenant_id = $2 AND s.is_active
     FOR UPDATE OF s`,
    [seriesId, tenantId],
  );
  if (!series.rows[0]) throw new AppError(ErrorCodes.numberSeriesNotFound, 'Invoice number series not found or inactive', 409);
  const next = await client.query(
    `UPDATE invoice_number_series
     SET next_number = next_number + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING next_number - 1 AS allocated`,
    [seriesId, tenantId],
  );
  const allocated = Number(next.rows[0].allocated);
  const running = String(allocated).padStart(6, '0');
  const year = series.rows[0].fy_start_date
    ? String(series.rows[0].fy_start_date).slice(0, 4)
    : issueDate.slice(0, 4);
  const prefix = String(series.rows[0].prefix ?? '');
  const invoiceNumber = `${prefix}${year}-${running}`;
  return { number: invoiceNumber, running, year };
}

function buildCustomerSnapshot(customer: any): Record<string, unknown> {
  return {
    name: customer.name,
    business_id: customer.business_id,
    vat_id: customer.vat_id,
    email: customer.email,
    phone: customer.phone,
    address_line1: customer.address_line1,
    address_line2: customer.address_line2,
    postal_code: customer.postal_code,
    city: customer.city,
    country_code: customer.country_code,
    language: customer.language,
    iban: customer.iban,
    e_invoice_address: customer.e_invoice_address,
    e_invoice_operator: customer.e_invoice_operator,
    e_invoice_ovt: customer.e_invoice_ovt,
    delivery_method: customer.delivery_method ?? 'EMAIL',
    payment_terms_days: customer.payment_terms_days ?? 14,
  };
}

interface IssueOptions {
  sourceType: 'SALES_INVOICE' | 'SALES_CREDIT_NOTE';
  creditOfInvoiceId?: string;
  customerSnapshotOverride?: Record<string, unknown>;
}

async function issueInvoiceInTransaction(
  client: DbClient,
  tenantId: string,
  userId: string,
  invoiceId: string,
  options: IssueOptions,
): Promise<any> {
  const invoice = await lockInvoice(client, tenantId, invoiceId);
  if (invoice.status !== 'DRAFT') {
    throw new AppError(
      invoice.status === 'CREDITED' || invoice.status === 'ISSUED'
        ? ErrorCodes.alreadyCredited
        : ErrorCodes.invoiceNotDraft,
      invoice.status === 'CREDITED'
        ? 'Invoice is already credited'
        : invoice.status === 'ISSUED'
          ? 'Invoice is already issued'
          : 'Invoice is not a draft',
      409,
    );
  }

  const customer = await client.query(
    'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2',
    [invoice.customer_id, tenantId],
  );
  if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
  if (!customer.rows[0].is_active) throw new AppError(ErrorCodes.customerInactive, 'Customer is inactive', 409);

  const settings = await ensureSalesSettingsRow(client, tenantId);
  const issueDate = toDateString(invoice.issue_date ?? today());
  const dueDate = toDateString(invoice.due_date ?? issueDate);
  if (dueDate < issueDate) {
    throw new AppError(ErrorCodes.invalidDueDate, 'Due date must not be before the invoice date', 400);
  }
  const currency = String(invoice.currency_code ?? 'EUR');
  const referenceType = String(invoice.reference_type ?? settings.payment_reference_type ?? 'FI_DOMESTIC') as PaymentReferenceType;
  if (!['FI_DOMESTIC', 'RF', 'NONE'].includes(referenceType)) {
    throw new AppError(ErrorCodes.referenceInvalid, 'Unsupported payment reference type', 400);
  }
  await validateCurrency(client, currency);

  // Recompute line amounts server-side and write the authoritative values.
  const lineRows = await client.query(
    `SELECT * FROM sales_invoice_lines
     WHERE sales_invoice_id = $1 AND tenant_id = $2
     ORDER BY line_number`,
    [invoiceId, tenantId],
  );
  if (lineRows.rows.length === 0) {
    throw new AppError(ErrorCodes.invoiceHasNoLines, 'Invoice requires at least one line', 400);
  }
  const taxIds = [...new Set(lineRows.rows.map((row: any) => String(row.tax_code_id)))].filter(
    (id): id is string => Boolean(id),
  );
  const taxMap = await loadTaxCodesForDate(client, tenantId, taxIds, issueDate);
  const baseComputed = lineRows.rows.map((row: any) => {
    const taxCode = taxMap.get(String(row.tax_code_id));
    if (!taxCode) {
      throw new AppError(
        ErrorCodes.invoiceTaxCodeInvalid,
        'Tax code is not active for the invoice date',
        400,
      );
    }
    if (!isTaxDirectionAllowed(String(taxCode.direction ?? 'BOTH') as any, 'SALES')) {
      throw new AppError(
        ErrorCodes.taxCodeDirectionIncompatible,
        'Tax code is not valid for sales invoices',
        400,
      );
    }
    const net = computeLineAmounts({
      quantity: String(row.quantity),
      unitPrice: String(row.unit_price),
      discountPercent: String(row.discount_percent ?? '0'),
      revenueAccountId: String(row.revenue_account_id),
      taxCode,
      invoiceLanguage: String(invoice.language ?? 'fi'),
    });
    return { row, taxCode, netBefore: net.net };
  });
  const discountAllocation = allocateInvoiceDiscount({
    lineNets: baseComputed.map((item) => item.netBefore),
    discountPercent: String(invoice.discount_percent ?? '0'),
    discountAmount: String(invoice.discount_amount ?? '0'),
  });
  const recomputed = baseComputed.map((item, index) => {
    const netAfter = new Decimal(item.netBefore).minus(new Decimal(discountAllocation.allocated[index]!));
    return {
      row: item.row,
      taxCode: item.taxCode,
      computed: computeLineAmounts({
        quantity: String(item.row.quantity),
        unitPrice: String(item.row.unit_price),
        discountPercent: String(item.row.discount_percent ?? '0'),
        netAmountOverride: money2(netAfter),
        revenueAccountId: String(item.row.revenue_account_id),
        taxCode: item.taxCode,
        invoiceLanguage: String(invoice.language ?? 'fi'),
      }),
    };
  });

  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (const item of recomputed) {
    await client.query(
      `UPDATE sales_invoice_lines
       SET net_amount = $3, tax_rate_snapshot = $4, tax_type_snapshot = $5,
           reporting_mapping_snapshot = $6, tax_amount = $7, gross_amount = $8,
           revenue_account_id = $9, tax_code_snapshot = $10, tax_treatment_snapshot = $11,
           deductible_percent_snapshot = $12, tax_legal_note = $13
       WHERE id = $1 AND tenant_id = $2`,
      [
        item.row.id,
        tenantId,
        item.computed.net,
        item.computed.taxRate,
        item.computed.taxType,
        item.computed.reportingMapping,
        item.computed.tax,
        item.computed.gross,
        item.computed.revenueAccountId,
        item.computed.taxCodeSnapshot,
        item.computed.treatment,
        item.computed.deductiblePercent,
        item.computed.taxLegalNote,
      ],
    );
    subtotal = subtotal.plus(new Decimal(item.computed.net));
    taxTotal = taxTotal.plus(new Decimal(item.computed.tax));
  }
  const total = subtotal.plus(taxTotal);
  if (total.lessThanOrEqualTo(0)) {
    throw new AppError(ErrorCodes.invalidInvoiceLine, 'Invoice total must be greater than zero', 400);
  }

  const allocated = await allocateInvoiceNumber(
    client,
    tenantId,
    String(invoice.series_id),
    issueDate,
  );
  const paddedRunning = allocated.running;
  const paymentReference = generatePaymentReference(referenceType, paddedRunning);
  const customerSnapshot = options.customerSnapshotOverride ?? buildCustomerSnapshot(customer.rows[0]);

  const deliveryMethod = String(
    invoice.delivery_method
    ?? customer.rows[0].delivery_method
    ?? settings.default_delivery_method
    ?? 'EMAIL',
  );
  const customerLateInterestEnabled = Boolean(customer.rows[0].late_interest_enabled);
  const customerLateInterestRate = new Decimal(String(customer.rows[0].late_interest_rate ?? '0'));
  const lateInterestEnabled = customerLateInterestEnabled
    ? customerLateInterestEnabled
    : Boolean(settings.late_interest_enabled);
  const lateInterestRate = customerLateInterestEnabled && customerLateInterestRate.greaterThan(0)
    ? money2(customerLateInterestRate)
    : money2(new Decimal(String(settings.late_interest_rate ?? '0')));
  const lateInterestGraceDays = Number(
    customer.rows[0].late_interest_grace_days ?? settings.late_interest_grace_days ?? 0,
  );
  const reminderFeeEnabled = Boolean(settings.reminder_fee_enabled);
  const reminderFeeAmount = reminderFeeEnabled
    ? money2(new Decimal(String(customer.rows[0].reminder_fee_amount ?? settings.reminder_fee_amount ?? '0')))
    : '0.00';

  // Build journal lines. AR debit = total; revenue credits aggregated per
  // (account, tax code); VAT payable credits aggregated per tax code.
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
  const arAccount = settings.accounts_receivable_account_id;
  const taxPayableAccount = settings.tax_payable_account_id;
  if (!arAccount) {
    throw new AppError(ErrorCodes.accountMappingMissing, 'Accounts receivable account is not configured', 409);
  }
  if (!settings.default_sales_revenue_account_id) {
    throw new AppError(ErrorCodes.accountMappingMissing, 'Default sales revenue account is not configured', 409);
  }
  if (taxTotal.greaterThan(0) && !taxPayableAccount) {
    throw new AppError(ErrorCodes.accountMappingMissing, 'Tax payable account is not configured', 409);
  }

  const isCredit = options.sourceType === 'SALES_CREDIT_NOTE';
  journalLines.push({
    accountId: String(arAccount),
    description: isCredit ? `Credit note ${allocated.number}` : `Sales invoice ${allocated.number}`,
    debit: isCredit ? '0' : total.toFixed(2),
    credit: isCredit ? total.toFixed(2) : '0',
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

  const revenueGroups = new Map<
    string,
    { accountId: string; net: Decimal; taxCode: any; computed: ComputedLine }
  >();
  const taxGroups = new Map<
    string,
    { accountId: string; tax: Decimal; base: Decimal; taxCode: any; computed: ComputedLine }
  >();
  for (const item of recomputed) {
    const net = new Decimal(item.computed.net);
    const tax = new Decimal(item.computed.tax);
    const revenueKey = `${item.computed.revenueAccountId}|${String(item.row.tax_code_id)}`;
    const existingRevenue = revenueGroups.get(revenueKey);
    if (existingRevenue) {
      existingRevenue.net = existingRevenue.net.plus(net);
    } else {
      revenueGroups.set(revenueKey, {
        accountId: item.computed.revenueAccountId,
        net,
        taxCode: item.taxCode,
        computed: item.computed,
      });
    }
    if (tax.greaterThan(0)) {
      const taxKey = `${String(taxPayableAccount)}|${String(item.row.tax_code_id)}`;
      const existingTax = taxGroups.get(taxKey);
      if (existingTax) {
        existingTax.tax = existingTax.tax.plus(tax);
        existingTax.base = existingTax.base.plus(net);
      } else {
        taxGroups.set(taxKey, {
          accountId: String(taxPayableAccount),
          tax,
          base: net,
          taxCode: item.taxCode,
          computed: item.computed,
        });
      }
    }
  }
  const invoiceLabel = isCredit ? `Credit note ${allocated.number}` : `Sales invoice ${allocated.number}`;
  for (const group of revenueGroups.values()) {
    if (group.net.lessThanOrEqualTo(0)) continue;
    const amount = group.net.toFixed(2);
    journalLines.push({
      accountId: group.accountId,
      description: invoiceLabel,
      debit: isCredit ? amount : '0',
      credit: isCredit ? '0' : amount,
      taxCodeId: String(group.taxCode.id),
      appliedTaxRate: String(group.taxCode.rate),
      taxSnapshot: `${String(group.taxCode.code)}|${String(group.taxCode.type)}`,
      taxCodeSnapshot: group.computed.taxCodeSnapshot,
      taxTreatmentSnapshot: group.computed.treatment,
      taxableBaseSnapshot: amount,
      taxAmountSnapshot: '0.00',
      taxDeductibleSnapshot: '0.00',
      taxNondeductibleSnapshot: '0.00',
      taxLegType: 'REVENUE',
      taxReportingClassification: group.computed.classification,
      taxLegalNote: group.computed.taxLegalNote,
    });
  }
  for (const group of taxGroups.values()) {
    if (group.tax.lessThanOrEqualTo(0)) continue;
    const amount = group.tax.toFixed(2);
    journalLines.push({
      accountId: group.accountId,
      description: invoiceLabel,
      debit: isCredit ? amount : '0',
      credit: isCredit ? '0' : amount,
      taxCodeId: String(group.taxCode.id),
      appliedTaxRate: String(group.taxCode.rate),
      taxSnapshot: `${String(group.taxCode.code)}|${String(group.taxCode.type)}`,
      taxCodeSnapshot: group.computed.taxCodeSnapshot,
      taxTreatmentSnapshot: group.computed.treatment,
      taxableBaseSnapshot: group.base.toFixed(2),
      taxAmountSnapshot: amount,
      taxDeductibleSnapshot: '0.00',
      taxNondeductibleSnapshot: '0.00',
      taxLegType: 'OUTPUT_VAT',
      taxReportingClassification: group.computed.classification,
      taxLegalNote: group.computed.taxLegalNote,
    });
  }

  const entryId = await createJournalDraftInTransaction(client, tenantId, userId, {
    businessDate: issueDate,
    description: isCredit ? `Credit note ${allocated.number}` : `Sales invoice ${allocated.number}`,
    currencyCode: currency,
    sourceType: options.sourceType,
    sourceId: invoiceId,
    lines: journalLines,
  });
  const entryNumber = await postJournalEntryInTransaction(client, tenantId, entryId, userId);

  await client.query(
    `INSERT INTO sales_invoice_pdfs (tenant_id, invoice_id, status)
     VALUES ($1, $2, 'GENERATING')
     ON CONFLICT (tenant_id, invoice_id) DO NOTHING`,
    [tenantId, invoiceId],
  );

  const updateResult = await client.query(
    `UPDATE sales_invoices
     SET status = 'ISSUED', invoice_number = $3, payment_reference = $4,
         customer_snapshot = $5::jsonb, subtotal = $6, tax_total = $7, total = $8,
         accounting_journal_entry_id = $9, issued_by = $10, issued_at = now(),
         discount_percent = $11, discount_amount = $12, advance_applied = $13,
         delivery_method = $14, delivery_status = 'NOT_SENT',
         late_interest_enabled = $15, late_interest_rate = $16,
         late_interest_grace_days = $17, reminder_fee_enabled = $18,
         reminder_fee_amount = $19, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
     RETURNING *`,
    [
      invoiceId,
      tenantId,
      allocated.number,
      paymentReference,
      JSON.stringify(customerSnapshot),
      subtotal.toFixed(2),
      taxTotal.toFixed(2),
      total.toFixed(2),
      entryId,
      userId,
      discountAllocation.percent,
      discountAllocation.amount,
      '0.00',
      deliveryMethod,
      lateInterestEnabled,
      lateInterestRate,
      lateInterestGraceDays,
      reminderFeeEnabled,
      reminderFeeAmount,
    ],
  );
  if (!updateResult.rows[0]) {
    throw new AppError(ErrorCodes.invoiceNotDraft, 'Invoice could not be issued', 409);
  }
  const issued = updateResult.rows[0];

  await appendOutboxInTransaction(client, tenantId, {
    eventType: 'SALES_INVOICE_ISSUED',
    aggregateType: 'sales_invoice',
    aggregateId: invoiceId,
    payload: {
      invoice_id: invoiceId,
      invoice_number: allocated.number,
      journal_entry_id: entryId,
      journal_entry_number: entryNumber,
      total: total.toFixed(2),
      currency_code: currency,
    },
  });
  await appendOutboxInTransaction(client, tenantId, {
    eventType: 'SALES_INVOICE_PDF_REQUESTED',
    aggregateType: 'sales_invoice',
    aggregateId: invoiceId,
    payload: { invoice_id: invoiceId, invoice_number: allocated.number },
  });

  return { invoice: normalizeDateFields(issued), entryId, entryNumber };
}

export async function issueInvoice(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  userId: string,
  options: { advanceAllocations?: AdvanceAllocationInput[] } = {},
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const row = await lockInvoice(client, tenantId, invoiceId);
    const needsSpecial = String(row.document_type ?? '') === 'ADVANCE_INVOICE'
      || (options.advanceAllocations && options.advanceAllocations.length > 0);
    if (needsSpecial) {
      return issueAdvanceOrAllocatedInvoiceInTransaction(client, tenantId, userId, invoiceId, {
        sourceType: String(row.document_type ?? '') === 'ADVANCE_INVOICE'
          ? 'ADVANCE_INVOICE'
          : 'SALES_INVOICE',
        advanceAllocations: options.advanceAllocations,
      });
    }
    return issueInvoiceInTransaction(client, tenantId, userId, invoiceId, {
      sourceType: 'SALES_INVOICE',
    });
  });
}

export async function creditInvoice(
  pool: Db,
  tenantId: string,
  originalInvoiceId: string,
  userId: string,
  reason: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const original = await lockInvoice(client, tenantId, originalInvoiceId);
    if (original.status === 'CREDITED') {
      throw new AppError(ErrorCodes.alreadyCredited, 'Invoice is already credited', 409);
    }
    if (original.status !== 'ISSUED') {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'Only issued invoices can be credited', 409);
    }
    const linkExists = await client.query(
      'SELECT id FROM sales_invoice_credit_links WHERE original_invoice_id = $1',
      [originalInvoiceId],
    );
    if (linkExists.rows[0]) {
      throw new AppError(ErrorCodes.alreadyCredited, 'Invoice is already credited', 409);
    }
    if (!reason || reason.trim().length < 3) {
      throw new AppError(ErrorCodes.invalidRequest, 'Credit reason is required', 400);
    }

    const settings = await ensureSalesSettingsRow(client, tenantId);
    const series = await resolveSeries(client, tenantId, settings, String(original.series_id));
    const companyId = await resolveCompanyId(client, tenantId, settings.company_id ?? null);
    const issueDate = today();
    const creditInvoice = await client.query(
      `INSERT INTO sales_invoices
         (tenant_id, company_id, customer_id, status, series_id, issue_date, due_date,
          currency_code, language, reference_type, credit_of_invoice_id, customer_snapshot,
          document_type, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, 'SALES_CREDIT_NOTE', $12)
       RETURNING *`,
      [
        tenantId,
        companyId,
        original.customer_id,
        series.id,
        issueDate,
        issueDate,
        original.currency_code,
        original.language,
        original.reference_type,
        originalInvoiceId,
        original.customer_snapshot,
        userId,
      ],
    );
    const creditId = String(creditInvoice.rows[0].id);
    const originalLines = await client.query(
      `SELECT description, quantity, unit, unit_price, discount_percent, tax_code_id,
              revenue_account_id
       FROM sales_invoice_lines
       WHERE sales_invoice_id = $1 AND tenant_id = $2
       ORDER BY line_number`,
      [originalInvoiceId, tenantId],
    );
    if (originalLines.rows.length === 0) {
      throw new AppError(ErrorCodes.invoiceHasNoLines, 'Original invoice has no lines', 409);
    }
    const lineInputs: InvoiceLineDraftInput[] = originalLines.rows.map((row: any) => ({
      description: `Credit: ${String(row.description)}`,
      quantity: String(row.quantity),
      unit: String(row.unit ?? ''),
      unit_price: String(row.unit_price),
      discount_percent: String(row.discount_percent ?? '0'),
      tax_code_id: String(row.tax_code_id),
      revenue_account_id: String(row.revenue_account_id),
    }));
    const draftInput: InvoiceDraftInput = {
      customer_id: original.customer_id,
      series_id: String(series.id),
      issue_date: issueDate,
      due_date: issueDate,
      currency_code: original.currency_code,
      language: original.language,
      reference_type: original.reference_type as PaymentReferenceType,
      lines: lineInputs,
    };
    const parsed = await parseInvoiceDraftInput(client, tenantId, draftInput);
    const totals = totalsFor(parsed.lines.map((line) => line.computed));
    await client.query(
      `UPDATE sales_invoices
       SET subtotal = $3, tax_total = $4, total = $5, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [creditId, tenantId, totals.subtotal, totals.taxTotal, totals.total],
    );
    await insertInvoiceLines(client, tenantId, creditId, parsed.lines);

    await issueInvoiceInTransaction(client, tenantId, userId, creditId, {
      sourceType: 'SALES_CREDIT_NOTE',
      creditOfInvoiceId: originalInvoiceId,
      customerSnapshotOverride:
        original.customer_snapshot && typeof original.customer_snapshot === 'object'
          ? original.customer_snapshot
          : undefined,
    });
    await client.query(
      `INSERT INTO sales_invoice_credit_links
         (tenant_id, original_invoice_id, credit_invoice_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, originalInvoiceId, creditId, reason.trim(), userId],
    );
    const updated = await client.query(
      `UPDATE sales_invoices
       SET status = 'CREDITED', credited_by_invoice_id = $3,
           credited_amount = $4, payment_status = 'PAID', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'ISSUED'
       RETURNING *`,
      [originalInvoiceId, tenantId, creditId, money2(new Decimal(String(original.total ?? '0')))],
    );
    if (!updated.rows[0]) {
      throw new AppError(ErrorCodes.alreadyCredited, 'Invoice could not be marked credited', 409);
    }
    return {
      original_invoice: normalizeDateFields(updated.rows[0]),
      credit_invoice: await getInvoiceById(client, tenantId, creditId),
    };
  });
}

export async function listInvoices(
  pool: Db,
  tenantId: string,
  filters: {
    status?: InvoiceStatus;
    customerId?: string;
    from?: string;
    to?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ invoices: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`i.status = $${values.length}`);
    }
    if (filters.customerId) {
      values.push(filters.customerId);
      clauses.push(`i.customer_id = $${values.length}`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`i.issue_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`i.issue_date <= $${values.length}::date`);
    }
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(
        `(i.invoice_number ILIKE $${values.length} OR bp.name ILIKE $${values.length})`,
      );
    }
    const join = 'JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id';
    const where = `WHERE i.tenant_id = $1${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
    const total = await client.query(
      `SELECT count(*)::int AS total FROM sales_invoices i ${join} ${where}`,
      values,
    );
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = await client.query(
      `SELECT i.*, bp.name AS customer_name,
              p.status AS pdf_status
       FROM sales_invoices i
       ${join}
       LEFT JOIN sales_invoice_pdfs p ON p.invoice_id = i.id AND p.tenant_id = i.tenant_id
       ${where}
       ORDER BY i.issue_date DESC NULLS LAST, i.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return {
      invoices: rows.rows.map((row: any) => {
        const normalized = normalizeDateFields(row);
        const paid = new Decimal(String(normalized.amount_paid ?? '0'));
        return {
          ...normalized,
          amount_paid: paid.toFixed(2),
          open_balance: openBalance({
            total: String(normalized.total ?? '0'),
            advanceApplied: String(normalized.advance_applied ?? '0'),
            credited: String(normalized.credited_amount ?? '0'),
            paid: paid.toFixed(2),
          }),
          overdue_days: overdueDays({ ...normalized, amount_paid: paid.toFixed(2) }),
        };
      }),
      total: Number(total.rows[0]?.total ?? 0),
    };
  });
}

export async function getInvoice(pool: Db, tenantId: string, invoiceId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT i.*, bp.name AS customer_name, p.status AS pdf_status, p.id AS pdf_id,
              p.sha256 AS pdf_sha256, p.failure_reason AS pdf_failure_reason
       FROM sales_invoices i
       JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id
       LEFT JOIN sales_invoice_pdfs p ON p.invoice_id = i.id AND p.tenant_id = i.tenant_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const lines = await client.query(
      `SELECT * FROM sales_invoice_lines
       WHERE sales_invoice_id = $1 AND tenant_id = $2
       ORDER BY line_number`,
      [invoiceId, tenantId],
    );
    return {
      ...normalizeDateFields(invoice.rows[0]),
      lines: lines.rows.map((line: any) => normalizeDateFields(line)),
    };
  });
}

export async function retryInvoicePdf(
  pool: Db,
  tenantId: string,
  invoiceId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      'SELECT status FROM sales_invoices WHERE id = $1 AND tenant_id = $2',
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    if (!['ISSUED', 'CREDITED'].includes(String(invoice.rows[0].status))) {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'PDF is only available after issue', 409);
    }
    const pdf = await client.query(
      `SELECT * FROM sales_invoice_pdfs
       WHERE invoice_id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [invoiceId, tenantId],
    );
    if (!pdf.rows[0]) {
      await client.query(
        `INSERT INTO sales_invoice_pdfs (tenant_id, invoice_id, status)
         VALUES ($1, $2, 'GENERATING')`,
        [tenantId, invoiceId],
      );
    } else if (pdf.rows[0].status === 'READY') {
      return pdf.rows[0];
    } else {
      if (pdf.rows[0].status !== 'FAILED') {
        throw new AppError(ErrorCodes.pdfNotReady, 'PDF generation is already in progress', 409);
      }
      await client.query(
        `UPDATE sales_invoice_pdfs
         SET status = 'GENERATING', failure_reason = NULL, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [pdf.rows[0].id, tenantId],
      );
    }
    await appendOutboxInTransaction(client, tenantId, {
      eventType: 'SALES_INVOICE_PDF_REQUESTED',
      aggregateType: 'sales_invoice',
      aggregateId: invoiceId,
      payload: { invoice_id: invoiceId, retry: true },
    });
    const updated = await client.query(
      `SELECT * FROM sales_invoice_pdfs WHERE invoice_id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    return updated.rows[0];
  });
}

export async function getInvoicePdfMetadata(
  pool: Db,
  tenantId: string,
  invoiceId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT p.*, i.invoice_number
       FROM sales_invoice_pdfs p
       JOIN sales_invoices i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
       WHERE p.invoice_id = $1 AND p.tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!result.rows[0]) {
      throw new AppError(ErrorCodes.pdfNotReady, 'Invoice PDF is not available', 404);
    }
    if (result.rows[0].status !== 'READY') {
      throw new AppError(ErrorCodes.pdfNotReady, 'Invoice PDF is not ready', 409);
    }
    return result.rows[0];
  });
}

/** Loads issued invoice data needed by the PDF worker (same tenant context). */
export async function getInvoiceForPdf(client: DbClient, tenantId: string, invoiceId: string): Promise<any> {
  const result = await client.query(
    `SELECT i.*,
            COALESCE(c.legal_name, '') AS seller_legal_name,
            COALESCE(c.business_id, '') AS seller_business_id,
            COALESCE(c.country_code, '') AS seller_country_code,
            COALESCE(ss.default_payment_terms_days, 14) AS payment_terms_days,
            COALESCE(ss.tax_payable_account_id::text, '') AS tax_payable_account_id,
            ss.bank_iban, ss.bank_bic, ss.bank_account_holder
     FROM sales_invoices i
     LEFT JOIN companies c ON c.id = i.company_id AND c.tenant_id = i.tenant_id
     LEFT JOIN sales_settings ss ON ss.tenant_id = i.tenant_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  if (!result.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
  const invoice = result.rows[0];
  const lines = await client.query(
    `SELECT * FROM sales_invoice_lines
     WHERE sales_invoice_id = $1 AND tenant_id = $2
     ORDER BY line_number`,
    [invoiceId, tenantId],
  );
  return {
    ...normalizeDateFields(invoice),
    lines: lines.rows.map((line: any) => normalizeDateFields(line)),
  };
}

function overdueDays(invoice: any, today = new Date().toISOString().slice(0, 10)): number {
  const due = String(invoice.due_date ?? '').slice(0, 10);
  if (!due || !['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERPAID'].includes(String(invoice.status))) return 0;
  const open = new Decimal(String(invoice.total ?? '0'))
    .minus(new Decimal(String(invoice.advance_applied ?? '0')))
    .minus(new Decimal(String(invoice.credited_amount ?? '0')))
    .minus(new Decimal(String(invoice.amount_paid ?? '0')));
  if (open.lessThanOrEqualTo(0)) return 0;
  return Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000));
}

export async function salesLedger(
  pool: Db,
  tenantId: string,
  filters: { status?: string; documentType?: string; customerId?: string; unpaid?: boolean; overdue?: boolean; search?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
): Promise<{ invoices: any[]; total: number; summary: { outstanding: string; overdue: string; dueSoon: string; paidThisPeriod: string } }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [`i.tenant_id = $1`];
    const values: unknown[] = [tenantId];
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`i.status = $${values.length}`);
    }
    if (filters.documentType) {
      values.push(filters.documentType);
      clauses.push(`i.document_type = $${values.length}`);
    }
    if (filters.customerId) {
      values.push(filters.customerId);
      clauses.push(`i.customer_id = $${values.length}`);
    }
    if (filters.unpaid) {
      clauses.push(`i.status IN ('ISSUED','PARTIALLY_PAID')`);
    }
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(`(i.invoice_number ILIKE $${values.length} OR bp.name ILIKE $${values.length})`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`i.issue_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`i.issue_date <= $${values.length}::date`);
    }
    const join = `JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id`;
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = await client.query(`SELECT count(*)::int AS total FROM sales_invoices i ${join} ${where}`, values);
    const summary = await client.query(
      `SELECT
         COALESCE(sum(CASE WHEN i.status IN ('ISSUED','PARTIALLY_PAID')
           THEN GREATEST(0, i.total - i.advance_applied - i.credited_amount - i.amount_paid)
           ELSE 0 END),0)::text AS outstanding,
         COALESCE(sum(CASE WHEN i.status IN ('ISSUED','PARTIALLY_PAID') AND i.due_date < current_date
           THEN GREATEST(0, i.total - i.advance_applied - i.credited_amount - i.amount_paid)
           ELSE 0 END),0)::text AS overdue,
         COALESCE(sum(CASE WHEN i.status IN ('ISSUED','PARTIALLY_PAID')
           AND i.due_date >= current_date AND i.due_date <= current_date + 30
           THEN GREATEST(0, i.total - i.advance_applied - i.credited_amount - i.amount_paid)
           ELSE 0 END),0)::text AS due_soon
       FROM sales_invoices i ${join} ${where}`,
      values,
    );
    const paidThisPeriod = await client.query(
      `SELECT COALESCE(sum(amount),0)::text AS paid
       FROM sales_invoice_payments
       WHERE tenant_id = $1 AND payment_date >= current_date - 30`,
      [tenantId],
    );
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const rows = await client.query(
      `SELECT i.*, bp.name AS customer_name,
              (SELECT COALESCE(sum(amount),0)::text FROM sales_invoice_payments p WHERE p.invoice_id = i.id AND p.tenant_id = i.tenant_id) AS paid_total
       FROM sales_invoices i ${join} ${where}
       ORDER BY i.issue_date DESC NULLS LAST, i.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const invoices = rows.rows.map((row: any) => {
      const paid = new Decimal(String(row.amount_paid ?? '0'));
      return {
        ...row,
        amount_paid: paid.toFixed(2),
        open_balance: openBalance({
          total: String(row.total ?? '0'),
          advanceApplied: String(row.advance_applied ?? '0'),
          credited: String(row.credited_amount ?? '0'),
          paid: paid.toFixed(2),
        }),
        overdue_days: overdueDays({ ...row, amount_paid: paid.toFixed(2) }),
      };
    });
    return {
      invoices,
      total: Number(total.rows[0]?.total ?? 0),
      summary: {
        outstanding: summary.rows[0]?.outstanding ?? '0.00',
        overdue: summary.rows[0]?.overdue ?? '0.00',
        dueSoon: summary.rows[0]?.due_soon ?? '0.00',
        paidThisPeriod: paidThisPeriod.rows[0]?.paid ?? '0.00',
      },
    };
  });
}

export async function recordSalesPayment(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  userId: string,
  input: { amount: string; paymentDate: string; method?: string; reference?: string; note?: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT * FROM sales_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const row = invoice.rows[0];
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(String(row.status))) {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'Only issued invoices can receive payments', 409);
    }
    const amount = new Decimal(input.amount);
    const paidBefore = new Decimal(String(row.amount_paid ?? '0'));
    const paid = paidBefore.plus(amount);
    const open = new Decimal(String(row.total ?? '0'))
      .minus(new Decimal(String(row.advance_applied ?? '0')))
      .minus(new Decimal(String(row.credited_amount ?? '0')))
      .minus(paidBefore);
    if (amount.lessThanOrEqualTo(0) || amount.greaterThan(open.plus(0.001))) {
      throw new AppError(ErrorCodes.invalidRequest, 'Payment amount exceeds open balance', 400);
    }
    const inserted = await client.query(
      `INSERT INTO sales_invoice_payments
         (tenant_id, invoice_id, amount, payment_date, method, reference, note, is_manual, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,true,$8) RETURNING *`,
      [tenantId, invoiceId, amount.toFixed(2), input.paymentDate, input.method ?? 'MANUAL', input.reference ?? null, input.note ?? null, userId],
    );
    const status = paymentStatusFor({
      total: String(row.total ?? '0'),
      advanceApplied: String(row.advance_applied ?? '0'),
      credited: String(row.credited_amount ?? '0'),
      paid: paid.toFixed(2),
    });
    await client.query(
      `UPDATE sales_invoices SET amount_paid = $3, payment_status = $4, paid_at = CASE WHEN $4 = 'PAID' THEN now() ELSE paid_at END
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId, paid.toFixed(2), status],
    );
    return { payment: inserted.rows[0], status, amount_paid: paid.toFixed(2) };
  });
}

export async function createSalesReminder(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  userId: string,
  input: { note?: string; level?: number; applyReminderFee?: boolean; asOf?: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT i.*, bp.name AS customer_name, bp.email FROM sales_invoices i
       JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const row = invoice.rows[0];
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(String(row.status))) {
      throw new AppError(ErrorCodes.invalidRequest, 'Reminders require an issued invoice', 400);
    }
    const amountDue = openBalance({
      total: String(row.total ?? '0'),
      advanceApplied: String(row.advance_applied ?? '0'),
      credited: String(row.credited_amount ?? '0'),
      paid: String(row.amount_paid ?? '0'),
    });
    const due = new Decimal(amountDue);
    if (due.lessThanOrEqualTo(0)) throw new AppError(ErrorCodes.invalidRequest, 'Invoice has no open balance', 400);
    const level = Number(input.level ?? 1);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new AppError(ErrorCodes.invalidRequest, 'Reminder level must be between 1 and 5', 400);
    }
    const asOf = input.asOf ?? today();
    const interest = calculateLateInterest({
      open: due.toFixed(2),
      dueDate: toDateString(row.due_date ?? asOf),
      asOf,
      annualRatePercent: String(row.late_interest_rate ?? '0'),
      graceDays: Number(row.late_interest_grace_days ?? 0),
      enabled: Boolean(row.late_interest_enabled),
    });
    const feeEnabled = Boolean(row.reminder_fee_enabled);
    const fee = feeEnabled && input.applyReminderFee === true
      ? new Decimal(String(row.reminder_fee_amount ?? '0'))
      : new Decimal(0);
    if (feeEnabled && input.applyReminderFee !== true && input.applyReminderFee !== false) {
      // Callers must explicitly confirm a reminder fee before it is applied.
      // The default (undefined/false) keeps the fee off.
    }
    const reminderNumber = row.invoice_number
      ? `REM-${String(row.invoice_number)}-${level}`
      : null;
    const result = await client.query(
      `INSERT INTO sales_reminders
         (tenant_id, invoice_id, level, amount_due, status, note, recipient, created_by,
          reminder_number, fee_amount, interest_amount, interest_rate, interest_days, language)
       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        tenantId,
        invoiceId,
        level,
        due.toFixed(2),
        input.note ?? null,
        row.email ?? null,
        userId,
        reminderNumber,
        fee.toFixed(2),
        interest.amount,
        String(row.late_interest_rate ?? '0'),
        interest.days,
        String(row.language ?? 'fi'),
      ],
    );
    return { reminder: result.rows[0], customer_name: row.customer_name };
  });
}

export async function listSalesReminders(pool: Db, tenantId: string, invoiceId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM sales_reminders WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY level, created_at`,
      [tenantId, invoiceId],
    );
    return result.rows;
  });
}

export async function listSalesPayments(pool: Db, tenantId: string, invoiceId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      'SELECT id FROM sales_invoices WHERE id = $1 AND tenant_id = $2',
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const result = await client.query(
      `SELECT * FROM sales_invoice_payments
       WHERE tenant_id = $1 AND invoice_id = $2
       ORDER BY payment_date, created_at`,
      [tenantId, invoiceId],
    );
    return result.rows.map((row: any) => ({
      ...row,
      amount: new Decimal(String(row.amount ?? '0')).toFixed(2),
    }));
  });
}

export async function getInvoiceAdvanceState(
  pool: Db,
  tenantId: string,
  invoiceId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT id, document_type, total FROM sales_invoices
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const row = invoice.rows[0];
    if (String(row.document_type) === 'ADVANCE_INVOICE') {
      const applied = await client.query(
        `SELECT COALESCE(sum(applied_amount), 0)::text AS applied FROM sales_invoice_advance_applications
         WHERE tenant_id = $1 AND advance_invoice_id = $2`,
        [tenantId, invoiceId],
      );
      const appliedValue = new Decimal(String(applied.rows[0]?.applied ?? '0'));
      const total = new Decimal(String(row.total ?? '0'));
      return {
        invoice_id: invoiceId,
        document_type: 'ADVANCE_INVOICE',
        total: total.toFixed(2),
        applied_total: appliedValue.toFixed(2),
        remaining: total.minus(appliedValue).greaterThan(0)
          ? total.minus(appliedValue).toFixed(2)
          : '0.00',
      };
    }
    const allocations = await client.query(
      `SELECT a.advance_invoice_id, a.applied_amount, i.invoice_number AS advance_number
       FROM sales_invoice_advance_applications a
       JOIN sales_invoices i ON i.id = a.advance_invoice_id AND i.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.final_invoice_id = $2
       ORDER BY a.created_at`,
      [tenantId, invoiceId],
    );
    return {
      invoice_id: invoiceId,
      document_type: String(row.document_type ?? 'SALES_INVOICE'),
      total: new Decimal(String(row.total ?? '0')).toFixed(2),
      allocations: allocations.rows.map((allocation: any) => ({
        advance_invoice_id: String(allocation.advance_invoice_id),
        advance_number: allocation.advance_number,
        applied_amount: new Decimal(String(allocation.applied_amount ?? '0')).toFixed(2),
      })),
    };
  });
}

export async function createRecurringTemplate(
  pool: Db,
  tenantId: string,
  userId: string,
  input: { customerId: string; name: string; frequency: string; startDate: string; endDate?: string; language?: string; paymentTermsDays?: number; lines: Array<{ description: string; quantity: string; unit?: string; unit_price: string; tax_code_id: string; discount_percent?: string }> },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const customer = await client.query(
      `SELECT id FROM business_parties WHERE id = $1 AND tenant_id = $2 AND is_customer`,
      [input.customerId, tenantId],
    );
    if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    const template = await client.query(
      `INSERT INTO recurring_invoice_templates
         (tenant_id, customer_id, name, frequency, start_date, end_date, next_run_date,
          language, payment_terms_days, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$5::date,$7,$8,true,$9) RETURNING *`,
      [tenantId, input.customerId, input.name, input.frequency, input.startDate, input.endDate ?? null, input.language ?? 'fi', input.paymentTermsDays ?? 14, userId],
    );
    const templateId = String(template.rows[0].id);
    let n = 1;
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO recurring_invoice_lines
           (tenant_id, template_id, line_number, description, quantity, unit, unit_price,
            discount_percent, tax_code_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, templateId, n, line.description, line.quantity, line.unit ?? '', line.unit_price, line.discount_percent ?? '0', line.tax_code_id],
      );
      n += 1;
    }
    return template.rows[0];
  });
}

export async function listRecurringTemplates(pool: Db, tenantId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT t.*, bp.name AS customer_name FROM recurring_invoice_templates t
       JOIN business_parties bp ON bp.id = t.customer_id AND bp.tenant_id = t.tenant_id
       WHERE t.tenant_id = $1 ORDER BY t.next_run_date`,
      [tenantId],
    );
    return result.rows;
  });
}

export async function generateDueRecurringInvoices(
  pool: Db,
  tenantId: string,
  userId: string,
  asOf = new Date().toISOString().slice(0, 10),
): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const due = await client.query(
      `SELECT t.* FROM recurring_invoice_templates t
       WHERE t.tenant_id = $1 AND t.is_active AND t.next_run_date <= $2::date
       ORDER BY t.next_run_date FOR UPDATE OF t`,
      [tenantId, asOf],
    );
    const generated: any[] = [];
    for (const template of due.rows) {
      const nextDate = toDateString(template.next_run_date);
      const key = `${template.id}:${nextDate}`;
      const existing = await client.query(
        `SELECT id FROM sales_invoices WHERE tenant_id = $1 AND source_recurring_key = $2`,
        [tenantId, key],
      );
      if (existing.rows[0]) continue;
      const lines = await client.query(
        `SELECT description, quantity, unit, unit_price, discount_percent, tax_code_id
         FROM recurring_invoice_lines WHERE template_id = $1 ORDER BY line_number`,
        [template.id],
      );
      const inserted = await client.query(
        `INSERT INTO sales_invoices
           (tenant_id, company_id, customer_id, status, series_id, issue_date, due_date,
            currency_code, language, customer_snapshot, document_type, payment_status,
            source_recurring_template_id, source_recurring_key, created_by)
         VALUES ($1,
                 (SELECT company_id FROM sales_settings WHERE tenant_id = $1),
                 $2,'DRAFT',
                 (SELECT default_invoice_series_id FROM sales_settings WHERE tenant_id = $1),
                 $3::date,
                 ($3::date + ($4::text || ' days')::interval)::date,
                 'EUR',$5,
                 COALESCE((SELECT jsonb_build_object('name', name, 'language', language) FROM business_parties WHERE id = $2 AND tenant_id = $1), '{}'),
                 'SALES_INVOICE','UNPAID',$6,$7,$8)
         RETURNING *`,
        [tenantId, template.customer_id, nextDate, template.payment_terms_days, template.language, template.id, key, userId],
      );
      const invoiceId = String(inserted.rows[0].id);
      let n = 1;
      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO sales_invoice_lines
             (tenant_id, sales_invoice_id, line_number, description, quantity, unit, unit_price,
              discount_percent, tax_code_id, net_amount, tax_amount, gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,0)`,
          [tenantId, invoiceId, n, line.description, line.quantity, line.unit ?? '', line.unit_price, line.discount_percent ?? '0', line.tax_code_id],
        );
        n += 1;
      }
      await client.query(
        `UPDATE recurring_invoice_templates SET next_run_date = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [template.id, tenantId, recurringNextRun(String(template.frequency) as any, nextDate)],
      );
      generated.push({ template_id: template.id, invoice_id: invoiceId });
    }
    return generated;
  });
}

// ---------------------------------------------------------------------------
// v0.12 completion: advance invoices and advance-allocated final invoices.
//
// Finnish VAT treatment (vero.fi, checked 2026-09-03): VAT on a prepayment is
// chargeable when the payment is received, not when the prepayment invoice is
// issued. Because v0.12 records payments as manual AR readiness records (no
// bank journal yet; v0.13 owns bank posting), an advance invoice is posted as
//  Dr Accounts receivable / Cr Advances received (no revenue, no VAT).
// Revenue and VAT for the allocated portion are recognised once, when the
// final invoice is issued (delivery point):  Dr Advances received (allocated),
// Dr Accounts receivable (remaining), Cr Revenue + Cr VAT (full delivery).
// ---------------------------------------------------------------------------

interface AdvanceAllocationInput {
  advanceInvoiceId: string;
  amount: string;
}

interface AdvanceIssueOptions {
  sourceType: 'SALES_INVOICE' | 'ADVANCE_INVOICE';
  advanceAllocations?: AdvanceAllocationInput[];
}

function money2(value: Decimal | string | number): string {
  return new Decimal(value).toFixed(2);
}

async function issueAdvanceOrAllocatedInvoiceInTransaction(
  client: DbClient,
  tenantId: string,
  userId: string,
  invoiceId: string,
  options: AdvanceIssueOptions,
): Promise<any> {
  const invoice = await lockInvoice(client, tenantId, invoiceId);
  if (invoice.status !== 'DRAFT') {
    throw new AppError(ErrorCodes.invoiceNotDraft, 'Invoice is not a draft', 409);
  }
  const isAdvance = String(invoice.document_type ?? '') === 'ADVANCE_INVOICE'
    || options.sourceType === 'ADVANCE_INVOICE';
  const allocations: Array<{ advance: any; amount: Decimal; lines: any[] }> = [];
  let advanceAppliedTotal = new Decimal(0);

  const customer = await client.query(
    'SELECT * FROM business_parties WHERE id = $1 AND tenant_id = $2',
    [invoice.customer_id, tenantId],
  );
  if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
  if (!customer.rows[0].is_active) throw new AppError(ErrorCodes.customerInactive, 'Customer is inactive', 409);

  const settings = await ensureSalesSettingsRow(client, tenantId);
  const issueDate = toDateString(invoice.issue_date ?? today());
  const dueDate = toDateString(invoice.due_date ?? issueDate);
  if (dueDate < issueDate) {
    throw new AppError(ErrorCodes.invalidDueDate, 'Due date must not be before the invoice date', 400);
  }
  const currency = String(invoice.currency_code ?? 'EUR');
  const referenceType = String(invoice.reference_type ?? settings.payment_reference_type ?? 'FI_DOMESTIC') as PaymentReferenceType;
  if (!['FI_DOMESTIC', 'RF', 'NONE'].includes(referenceType)) {
    throw new AppError(ErrorCodes.referenceInvalid, 'Unsupported payment reference type', 400);
  }
  await validateCurrency(client, currency);

  // ---- advance validation ------------------------------------------------
  if (!isAdvance && options.advanceAllocations && options.advanceAllocations.length > 0) {
    for (const plan of options.advanceAllocations) {
      const amount = new Decimal(plan.amount);
      if (amount.lessThanOrEqualTo(0)) {
        throw new AppError(ErrorCodes.invalidRequest, 'Advance allocation amount must be positive', 400);
      }
      const advanceRows = await client.query(
        `SELECT * FROM sales_invoices
         WHERE id = $1 AND tenant_id = $2 AND document_type = 'ADVANCE_INVOICE'
           AND status = 'ISSUED' AND currency_code = $3
         FOR UPDATE`,
        [plan.advanceInvoiceId, tenantId, currency],
      );
      const advance = advanceRows.rows[0];
      if (!advance) {
        throw new AppError(
          ErrorCodes.invoiceNotFound,
          'Advance invoice not found, not issued or currency mismatch',
          400,
        );
      }
      const already = await client.query(
        `SELECT COALESCE(sum(applied_amount), 0)::text AS applied
         FROM sales_invoice_advance_applications
         WHERE tenant_id = $1 AND advance_invoice_id = $2`,
        [tenantId, plan.advanceInvoiceId],
      );
      const allocatedSoFar = new Decimal(String(already.rows[0]?.applied ?? '0'));
      const advanceTotal = new Decimal(String(advance.total ?? '0'));
      if (amount.greaterThan(advanceTotal.minus(allocatedSoFar).plus(0.001))) {
        throw new AppError(
          ErrorCodes.invalidRequest,
          'Advance allocation exceeds the remaining advance balance',
          400,
        );
      }
      const advanceLines = await client.query(
        `SELECT * FROM sales_invoice_lines
         WHERE sales_invoice_id = $1 AND tenant_id = $2
         ORDER BY line_number`,
        [plan.advanceInvoiceId, tenantId],
      );
      allocations.push({ advance, amount, lines: advanceLines.rows });
      advanceAppliedTotal = advanceAppliedTotal.plus(amount);
    }
  }

  // ---- server-side amount recomputation incl. invoice-level discount -----
  const lineRows = await client.query(
    `SELECT * FROM sales_invoice_lines
     WHERE sales_invoice_id = $1 AND tenant_id = $2
     ORDER BY line_number`,
    [invoiceId, tenantId],
  );
  if (lineRows.rows.length === 0) {
    throw new AppError(ErrorCodes.invoiceHasNoLines, 'Invoice requires at least one line', 400);
  }
  const taxIds = [...new Set(lineRows.rows.map((row: any) => String(row.tax_code_id)))].filter(
    (id): id is string => Boolean(id),
  );
  const taxMap = await loadTaxCodesForDate(client, tenantId, taxIds, issueDate);
  const baseLines = lineRows.rows.map((row: any) => {
    const taxCode = taxMap.get(String(row.tax_code_id));
    if (!taxCode) {
      throw new AppError(ErrorCodes.invoiceTaxCodeInvalid, 'Tax code is not active for the invoice date', 400);
    }
    if (!isTaxDirectionAllowed(String(taxCode.direction ?? 'BOTH') as any, 'SALES')) {
      throw new AppError(ErrorCodes.taxCodeDirectionIncompatible, 'Tax code is not valid for sales invoices', 400);
    }
    const computed = computeLineAmounts({
      quantity: String(row.quantity),
      unitPrice: String(row.unit_price),
      discountPercent: String(row.discount_percent ?? '0'),
      revenueAccountId: String(row.revenue_account_id),
      taxCode,
      invoiceLanguage: String(invoice.language ?? 'fi'),
    });
    return { row, taxCode, netBefore: computed.net };
  });
  const discountAllocation = allocateInvoiceDiscount({
    lineNets: baseLines.map((item) => item.netBefore),
    discountPercent: String(invoice.discount_percent ?? '0'),
    discountAmount: String(invoice.discount_amount ?? '0'),
  });

  const recomputed: Array<{ row: any; computed: ComputedLine; taxCode: any }> = [];
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (let index = 0; index < baseLines.length; index += 1) {
    const item = baseLines[index]!;
    const netAfter = new Decimal(item.netBefore).minus(new Decimal(discountAllocation.allocated[index]!));
    const computed = computeLineAmounts({
      quantity: String(item.row.quantity),
      unitPrice: String(item.row.unit_price),
      discountPercent: String(item.row.discount_percent ?? '0'),
      netAmountOverride: money2(netAfter),
      revenueAccountId: String(item.row.revenue_account_id),
      taxCode: item.taxCode,
      invoiceLanguage: String(invoice.language ?? 'fi'),
    });
    recomputed.push({ row: item.row, computed, taxCode: item.taxCode });
    await client.query(
      `UPDATE sales_invoice_lines
       SET net_amount = $3, tax_rate_snapshot = $4, tax_type_snapshot = $5,
           reporting_mapping_snapshot = $6, tax_amount = $7, gross_amount = $8,
           revenue_account_id = $9, tax_code_snapshot = $10, tax_treatment_snapshot = $11,
           deductible_percent_snapshot = $12, tax_legal_note = $13
       WHERE id = $1 AND tenant_id = $2`,
      [
        item.row.id,
        tenantId,
        computed.net,
        computed.taxRate,
        computed.taxType,
        computed.reportingMapping,
        computed.tax,
        computed.gross,
        computed.revenueAccountId,
        computed.taxCodeSnapshot,
        computed.treatment,
        computed.deductiblePercent,
        computed.taxLegalNote,
      ],
    );
    subtotal = subtotal.plus(new Decimal(computed.net));
    taxTotal = taxTotal.plus(new Decimal(computed.tax));
  }
  const total = subtotal.plus(taxTotal);
  if (total.lessThanOrEqualTo(0)) {
    throw new AppError(ErrorCodes.invalidInvoiceLine, 'Invoice total must be greater than zero', 400);
  }
  if (advanceAppliedTotal.greaterThan(total.plus(0.001))) {
    throw new AppError(
      ErrorCodes.invalidRequest,
      'Advance allocations cannot exceed the final invoice total',
      400,
    );
  }

  const allocated = await allocateInvoiceNumber(client, tenantId, String(invoice.series_id), issueDate);
  const paymentReference = generatePaymentReference(referenceType, allocated.running);
  const customerSnapshot = buildCustomerSnapshot(customer.rows[0]);

  // ---- freeze delivery and reminder policy --------------------------------
  const deliveryMethod = String(
    invoice.delivery_method
    ?? customer.rows[0].delivery_method
    ?? settings.default_delivery_method
    ?? 'EMAIL',
  );
  if (!['EMAIL', 'E_INVOICE', 'PDF_MANUAL', 'OTHER'].includes(deliveryMethod)) {
    throw new AppError(ErrorCodes.invalidRequest, 'Invalid delivery method', 400);
  }
  const customerLateInterestEnabled = Boolean(customer.rows[0].late_interest_enabled);
  const customerLateInterestRate = new Decimal(String(customer.rows[0].late_interest_rate ?? '0'));
  const lateInterestEnabled = customerLateInterestEnabled
    ? customerLateInterestEnabled
    : Boolean(settings.late_interest_enabled);
  const lateInterestRate = customerLateInterestEnabled && customerLateInterestRate.greaterThan(0)
    ? money2(customerLateInterestRate)
    : money2(new Decimal(String(settings.late_interest_rate ?? '0')));
  const lateInterestGraceDays = Number(
    customer.rows[0].late_interest_grace_days ?? settings.late_interest_grace_days ?? 0,
  );
  const reminderFeeEnabled = Boolean(settings.reminder_fee_enabled);
  const reminderFeeAmount = reminderFeeEnabled
    ? money2(new Decimal(String(customer.rows[0].reminder_fee_amount ?? settings.reminder_fee_amount ?? '0')))
    : '0.00';

  // ---- journal --------------------------------------------------------------
  const arAccount = settings.accounts_receivable_account_id;
  if (!arAccount) {
    throw new AppError(ErrorCodes.accountMappingMissing, 'Accounts receivable account is not configured', 409);
  }
  const liabilityAccount = settings.advance_payments_received_account_id;
  if ((isAdvance || advanceAppliedTotal.greaterThan(0)) && !liabilityAccount) {
    throw new AppError(
      ErrorCodes.accountMappingMissing,
      'Advance payments received account is not configured',
      409,
    );
  }

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
  const label = isAdvance ? `Advance invoice ${allocated.number}` : `Final invoice ${allocated.number}`;
  const amountDue = total.minus(advanceAppliedTotal);

  if (isAdvance) {
    journalLines.push({
      accountId: String(arAccount),
      description: label,
      debit: money2(total),
      credit: '0',
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
    journalLines.push({
      accountId: String(liabilityAccount),
      description: label,
      debit: '0',
      credit: money2(total),
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
  } else {
    if (advanceAppliedTotal.greaterThan(0)) {
      journalLines.push({
        accountId: String(liabilityAccount),
        description: label,
        debit: money2(advanceAppliedTotal),
        credit: '0',
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
    }
    if (amountDue.greaterThan(0)) {
      journalLines.push({
        accountId: String(arAccount),
        description: label,
        debit: money2(amountDue),
        credit: '0',
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
    }
  }

  const revenueGroups = new Map<
    string,
    { accountId: string; net: Decimal; taxCodeId: string; computed: ComputedLine }
  >();
  const taxGroups = new Map<
    string,
    { accountId: string; tax: Decimal; base: Decimal; taxCodeId: string; computed: ComputedLine }
  >();
  const taxPayableAccount = settings.tax_payable_account_id;
  const addRevenue = (accountId: string, taxCodeId: string, net: Decimal, computed: ComputedLine) => {
    const key = `${accountId}|${taxCodeId}`;
    const existing = revenueGroups.get(key);
    if (existing) existing.net = existing.net.plus(net);
    else revenueGroups.set(key, { accountId, net, taxCodeId, computed });
  };
  const addTax = (accountId: string, taxCodeId: string, tax: Decimal, base: Decimal, computed: ComputedLine) => {
    const key = `${accountId}|${taxCodeId}`;
    const existing = taxGroups.get(key);
    if (existing) {
      existing.tax = existing.tax.plus(tax);
      existing.base = existing.base.plus(base);
    } else {
      taxGroups.set(key, { accountId, tax, base, taxCodeId, computed });
    }
  };

  if (!isAdvance) {
    for (const item of recomputed) {
      const net = new Decimal(item.computed.net);
      const tax = new Decimal(item.computed.tax);
      addRevenue(String(item.computed.revenueAccountId), String(item.row.tax_code_id), net, item.computed);
      if (tax.greaterThan(0)) {
        if (!taxPayableAccount) {
          throw new AppError(ErrorCodes.accountMappingMissing, 'Tax payable account is not configured', 409);
        }
        addTax(String(taxPayableAccount), String(item.row.tax_code_id), tax, net, item.computed);
      }
    }

    for (const group of revenueGroups.values()) {
      if (group.net.lessThanOrEqualTo(0)) continue;
      const amount = money2(group.net);
      journalLines.push({
        accountId: group.accountId,
        description: label,
        debit: '0',
        credit: amount,
        taxCodeId: group.taxCodeId,
        appliedTaxRate: group.computed.taxRate,
        taxSnapshot: `${group.computed.taxCodeSnapshot}|${group.computed.taxType}`,
        taxCodeSnapshot: group.computed.taxCodeSnapshot,
        taxTreatmentSnapshot: group.computed.treatment,
        taxableBaseSnapshot: amount,
        taxAmountSnapshot: '0.00',
        taxDeductibleSnapshot: '0.00',
        taxNondeductibleSnapshot: '0.00',
        taxLegType: 'REVENUE',
        taxReportingClassification: group.computed.classification,
        taxLegalNote: group.computed.taxLegalNote,
      });
    }
    for (const group of taxGroups.values()) {
      if (group.tax.lessThanOrEqualTo(0)) continue;
      const amount = money2(group.tax);
      journalLines.push({
        accountId: group.accountId,
        description: label,
        debit: '0',
        credit: amount,
        taxCodeId: group.taxCodeId,
        appliedTaxRate: group.computed.taxRate,
        taxSnapshot: `${group.computed.taxCodeSnapshot}|${group.computed.taxType}`,
        taxCodeSnapshot: group.computed.taxCodeSnapshot,
        taxTreatmentSnapshot: group.computed.treatment,
        taxableBaseSnapshot: money2(group.base),
        taxAmountSnapshot: amount,
        taxDeductibleSnapshot: '0.00',
        taxNondeductibleSnapshot: '0.00',
        taxLegType: 'OUTPUT_VAT',
        taxReportingClassification: group.computed.classification,
        taxLegalNote: group.computed.taxLegalNote,
      });
    }
  }
  if (journalLines.length < 2) {
    throw new AppError(ErrorCodes.invalidRequest, 'Journal requires at least two lines', 400);
  }

  const entryId = await createJournalDraftInTransaction(client, tenantId, userId, {
    businessDate: issueDate,
    description: label,
    currencyCode: currency,
    sourceType: isAdvance ? 'ADVANCE_INVOICE' : 'SALES_INVOICE',
    sourceId: invoiceId,
    lines: journalLines,
  });
  const entryNumber = await postJournalEntryInTransaction(client, tenantId, entryId, userId);

  // ---- freeze the issued row -------------------------------------------------
  const updateResult = await client.query(
    `UPDATE sales_invoices
     SET status = 'ISSUED', invoice_number = $3, payment_reference = $4,
         customer_snapshot = $5::jsonb, subtotal = $6, tax_total = $7, total = $8,
         accounting_journal_entry_id = $9, issued_by = $10, issued_at = now(),
         discount_percent = $11, discount_amount = $12, advance_applied = $13,
         delivery_method = $14, delivery_status = 'NOT_SENT',
         late_interest_enabled = $15, late_interest_rate = $16,
         late_interest_grace_days = $17, reminder_fee_enabled = $18,
         reminder_fee_amount = $19, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
     RETURNING *`,
    [
      invoiceId,
      tenantId,
      allocated.number,
      paymentReference,
      JSON.stringify(customerSnapshot),
      money2(subtotal),
      money2(taxTotal),
      money2(total),
      entryId,
      userId,
      discountAllocation.percent,
      discountAllocation.amount,
      money2(advanceAppliedTotal),
      deliveryMethod,
      lateInterestEnabled,
      lateInterestRate,
      lateInterestGraceDays,
      reminderFeeEnabled,
      reminderFeeAmount,
    ],
  );
  if (!updateResult.rows[0]) {
    throw new AppError(ErrorCodes.invoiceNotDraft, 'Invoice could not be issued', 409);
  }
  const issued = updateResult.rows[0];

  if (!isAdvance && allocations.length > 0) {
    for (const plan of allocations) {
      await client.query(
        `INSERT INTO sales_invoice_advance_applications
           (tenant_id, final_invoice_id, advance_invoice_id, applied_amount, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, invoiceId, plan.advance.id, money2(plan.amount), userId],
      );
    }
  }

  await client.query(
    `INSERT INTO sales_invoice_pdfs (tenant_id, invoice_id, status)
     VALUES ($1, $2, 'GENERATING')
     ON CONFLICT (tenant_id, invoice_id) DO NOTHING`,
    [tenantId, invoiceId],
  );
  await appendOutboxInTransaction(client, tenantId, {
    eventType: 'SALES_INVOICE_ISSUED',
    aggregateType: 'sales_invoice',
    aggregateId: invoiceId,
    payload: {
      invoice_id: invoiceId,
      invoice_number: allocated.number,
      journal_entry_id: entryId,
      journal_entry_number: entryNumber,
      total: money2(total),
      currency_code: currency,
      document_type: isAdvance ? 'ADVANCE_INVOICE' : 'SALES_INVOICE',
      advance_applied: money2(advanceAppliedTotal),
    },
  });
  await appendOutboxInTransaction(client, tenantId, {
    eventType: 'SALES_INVOICE_PDF_REQUESTED',
    aggregateType: 'sales_invoice',
    aggregateId: invoiceId,
    payload: { invoice_id: invoiceId, invoice_number: allocated.number },
  });

  return { invoice: normalizeDateFields(issued), entryId, entryNumber };
}

/**
 * Issues a draft as an advance invoice or as a final invoice with advance
 * allocations. Plain invoices continue to use `issueInvoice` (unchanged path).
 */
export async function issueSpecialSalesInvoice(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  userId: string,
  options: { advanceAllocations?: AdvanceAllocationInput[] } = {},
): Promise<any> {
  return withTenantTransaction(pool, tenantId, (client) =>
    issueAdvanceOrAllocatedInvoiceInTransaction(client, tenantId, userId, invoiceId, {
      sourceType: 'SALES_INVOICE',
      advanceAllocations: options.advanceAllocations,
    }),
  );
}

// ---------------------------------------------------------------------------
// Partial credit notes.
// ---------------------------------------------------------------------------

export interface PartialCreditLineInput {
  sales_invoice_line_id: string;
  quantity?: string;
  unit_price?: string;
}

export async function getCreditableSummary(
  pool: Db,
  tenantId: string,
  invoiceId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await client.query(
      `SELECT id, status, total, advance_applied, credited_amount, currency_code
       FROM sales_invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Invoice not found', 404);
    const row = invoice.rows[0];
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(String(row.status))) {
      return { creditable: '0.00', credited: String(row.credited_amount ?? '0'), invoice_id: invoiceId };
    }
    const total = new Decimal(String(row.total ?? '0'));
    const advanceApplied = new Decimal(String(row.advance_applied ?? '0'));
    const credited = new Decimal(String(row.credited_amount ?? '0'));
    const creditable = total.minus(advanceApplied).minus(credited);
    return {
      invoice_id: invoiceId,
      total: money2(total),
      advance_applied: money2(advanceApplied),
      credited: money2(credited),
      creditable: creditable.greaterThan(0) ? money2(creditable) : '0.00',
      currency: row.currency_code,
    };
  });
}

export async function listCreditNotes(
  pool: Db,
  tenantId: string,
  originalInvoiceId: string,
): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT c.id, c.invoice_number, c.total, c.issue_date, c.status, l.reason, l.created_at
       FROM sales_invoice_credit_links l
       JOIN sales_invoices c ON c.id = l.credit_invoice_id AND c.tenant_id = l.tenant_id
       WHERE l.original_invoice_id = $1 AND l.tenant_id = $2
       ORDER BY l.created_at`,
      [originalInvoiceId, tenantId],
    );
    return result.rows.map((row: any) => normalizeDateFields(row));
  });
}

/**
 * Creates and issues a full or partial credit note against an issued invoice.
 * Server-side validation prevents credits beyond the remaining creditable
 * amount and per-line quantity/price caps. Multiple partial credits are
 * supported until the invoice is fully credited.
 */
export async function createCreditNote(
  pool: Db,
  tenantId: string,
  originalInvoiceId: string,
  userId: string,
  input: { reason: string; lines?: PartialCreditLineInput[] },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const original = await lockInvoice(client, tenantId, originalInvoiceId);
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(String(original.status))) {
      throw new AppError(
        original.status === 'CREDITED' ? ErrorCodes.alreadyCredited : ErrorCodes.invoiceNotDraft,
        original.status === 'CREDITED' ? 'Invoice is already credited' : 'Only issued invoices can be credited',
        409,
      );
    }
    if (!input.reason || input.reason.trim().length < 3) {
      throw new AppError(ErrorCodes.invalidRequest, 'Credit reason is required', 400);
    }
    const originalTotal = new Decimal(String(original.total ?? '0'));
    const creditable = originalTotal
      .minus(new Decimal(String(original.advance_applied ?? '0')))
      .minus(new Decimal(String(original.credited_amount ?? '0')));
    if (creditable.lessThanOrEqualTo(0.001)) {
      throw new AppError(ErrorCodes.alreadyCredited, 'Invoice has no remaining creditable amount', 409);
    }
    const partial = Array.isArray(input.lines) && input.lines.length > 0;

    const originalLines = await client.query(
      `SELECT * FROM sales_invoice_lines
       WHERE sales_invoice_id = $1 AND tenant_id = $2
       ORDER BY line_number`,
      [originalInvoiceId, tenantId],
    );
    if (originalLines.rows.length === 0) {
      throw new AppError(ErrorCodes.invoiceHasNoLines, 'Original invoice has no lines', 409);
    }

    let lineInputs: InvoiceLineDraftInput[];
    if (!partial) {
      if (new Decimal(String(original.credited_amount ?? '0')).greaterThan(0)
          || new Decimal(String(original.advance_applied ?? '0')).greaterThan(0)) {
        throw new AppError(
          ErrorCodes.invalidRequest,
          'Partially credited or advance-allocated invoices require explicit credit lines',
          400,
        );
      }
      lineInputs = originalLines.rows.map((row: any) => ({
        description: `Credit: ${String(row.description)}`,
        quantity: String(row.quantity),
        unit: String(row.unit ?? ''),
        unit_price: String(row.unit_price),
        discount_percent: String(row.discount_percent ?? '0'),
        tax_code_id: String(row.tax_code_id),
        revenue_account_id: String(row.revenue_account_id),
      }));
    } else {
      const lineById = new Map<string, any>(
        originalLines.rows.map((row: any) => [String(row.id), row]),
      );
      lineInputs = input.lines!.map((selection) => {
        const originalLine = lineById.get(selection.sales_invoice_line_id);
        if (!originalLine) {
          throw new AppError(
            ErrorCodes.invalidInvoiceLine,
            'Credit line does not belong to the original invoice',
            400,
          );
        }
        const quantity = new Decimal(String(selection.quantity ?? originalLine.quantity));
        const unitPrice = new Decimal(String(selection.unit_price ?? originalLine.unit_price));
        const originalQuantity = new Decimal(String(originalLine.quantity));
        const originalUnitPrice = new Decimal(String(originalLine.unit_price));
        if (quantity.lessThanOrEqualTo(0) || quantity.greaterThan(originalQuantity.plus(0.000001))) {
          throw new AppError(ErrorCodes.invalidInvoiceLine, 'Credit quantity exceeds the original quantity', 400);
        }
        if (unitPrice.lessThanOrEqualTo(0) || unitPrice.greaterThan(originalUnitPrice.plus(0.000001))) {
          throw new AppError(ErrorCodes.invalidInvoiceLine, 'Credit unit price exceeds the original unit price', 400);
        }
        return {
          description: `Credit: ${String(originalLine.description)}`,
          quantity: money2(quantity),
          unit: String(originalLine.unit ?? ''),
          unit_price: money2(unitPrice),
          discount_percent: String(originalLine.discount_percent ?? '0'),
          tax_code_id: String(originalLine.tax_code_id),
          revenue_account_id: String(originalLine.revenue_account_id),
        };
      });
    }

    const settings = await ensureSalesSettingsRow(client, tenantId);
    const series = await resolveSeries(client, tenantId, settings, String(original.series_id));
    const companyId = await resolveCompanyId(client, tenantId, settings.company_id ?? null);
    const issueDate = today();
    const creditInvoiceRow = await client.query(
      `INSERT INTO sales_invoices
         (tenant_id, company_id, customer_id, status, series_id, issue_date, due_date,
          currency_code, language, reference_type, credit_of_invoice_id, customer_snapshot,
          document_type, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, 'SALES_CREDIT_NOTE', $12)
       RETURNING *`,
      [
        tenantId,
        companyId,
        original.customer_id,
        series.id,
        issueDate,
        issueDate,
        original.currency_code,
        original.language,
        original.reference_type,
        originalInvoiceId,
        original.customer_snapshot,
        userId,
      ],
    );
    const creditId = String(creditInvoiceRow.rows[0].id);
    const draftInput: InvoiceDraftInput = {
      customer_id: original.customer_id,
      series_id: String(series.id),
      issue_date: issueDate,
      due_date: issueDate,
      currency_code: original.currency_code,
      language: original.language,
      reference_type: original.reference_type as PaymentReferenceType,
      lines: lineInputs,
    };
    const parsed = await parseInvoiceDraftInput(client, tenantId, draftInput);
    const totals = totalsFor(parsed.lines.map((line) => line.computed));
    const remainingForCredit = creditable;
    if (new Decimal(totals.total).greaterThan(remainingForCredit.plus(0.001))) {
      throw new AppError(ErrorCodes.invalidRequest, 'Credit exceeds the remaining creditable amount', 400);
    }
    await client.query(
      `UPDATE sales_invoices
       SET subtotal = $3, tax_total = $4, total = $5, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [creditId, tenantId, totals.subtotal, totals.taxTotal, totals.total],
    );
    await insertInvoiceLines(client, tenantId, creditId, parsed.lines);

    await issueInvoiceInTransaction(client, tenantId, userId, creditId, {
      sourceType: 'SALES_CREDIT_NOTE',
      creditOfInvoiceId: originalInvoiceId,
      customerSnapshotOverride:
        original.customer_snapshot && typeof original.customer_snapshot === 'object'
          ? original.customer_snapshot
          : undefined,
    });
    await client.query(
      `INSERT INTO sales_invoice_credit_links
         (tenant_id, original_invoice_id, credit_invoice_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, originalInvoiceId, creditId, input.reason.trim(), userId],
    );

    const creditTotal = new Decimal(String(totals.total));
    const newCredited = new Decimal(String(original.credited_amount ?? '0')).plus(creditTotal);
    const creditableBase = originalTotal.minus(new Decimal(String(original.advance_applied ?? '0')));
    const fullyCredited = newCredited.greaterThanOrEqualTo(creditableBase.minus(0.01));
    const updated = await client.query(
      fullyCredited
        ? `UPDATE sales_invoices
           SET status = 'CREDITED', credited_by_invoice_id = $3, credited_amount = $4,
               payment_status = 'PAID', updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status IN ('ISSUED','PARTIALLY_PAID')
           RETURNING *`
        : `UPDATE sales_invoices
           SET credited_amount = $3, updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status IN ('ISSUED','PARTIALLY_PAID')
           RETURNING *`,
      fullyCredited
        ? [originalInvoiceId, tenantId, creditId, money2(newCredited)]
        : [originalInvoiceId, tenantId, money2(newCredited)],
    );
    if (!updated.rows[0]) {
      throw new AppError(ErrorCodes.alreadyCredited, 'Invoice could not be credited', 409);
    }
    return {
      original_invoice: normalizeDateFields(updated.rows[0]),
      credit_invoice: await getInvoiceById(client, tenantId, creditId),
      partial: !fullyCredited,
    };
  });
}

// ---------------------------------------------------------------------------
// AR aging, customer statements and customer-level balances.
// ---------------------------------------------------------------------------

function dateOrError(value: unknown, fallback: string): string {
  const raw = String(value ?? '');
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(ErrorCodes.invalidRequest, 'Invalid date', 400);
  }
  return raw;
}

export async function salesAging(
  pool: Db,
  tenantId: string,
  filters: { asOf?: string; customerId?: string } = {},
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const asOf = dateOrError(filters.asOf, today());
    const clauses: string[] = [
      `i.tenant_id = $1`,
      `i.status IN ('ISSUED','PARTIALLY_PAID')`,
    ];
    const values: unknown[] = [tenantId];
    if (filters.customerId) {
      values.push(filters.customerId);
      clauses.push(`i.customer_id = $${values.length}`);
    }
    const rows = await client.query(
      `SELECT i.id, i.invoice_number, i.customer_id, bp.name AS customer_name,
              i.issue_date, i.due_date, i.total, i.advance_applied, i.credited_amount,
              i.amount_paid, i.currency_code, i.document_type, i.payment_status
       FROM sales_invoices i
       JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY i.due_date`,
      values,
    );
    const invoices = rows.rows.map((row: any) => {
      const paid = String(row.amount_paid ?? '0');
      const open = openBalance({
        total: String(row.total ?? '0'),
        advanceApplied: String(row.advance_applied ?? '0'),
        credited: String(row.credited_amount ?? '0'),
        paid,
      });
      return {
        ...row,
        amount_paid: paid,
        open_balance: open,
        bucket: agingBucketFor({
          dueDate: String(row.due_date ?? ''),
          asOf,
          total: String(row.total ?? '0'),
          advanceApplied: String(row.advance_applied ?? '0'),
          credited: String(row.credited_amount ?? '0'),
          paid,
        }),
        overdue_days: overdueDays({
          ...row,
          amount_paid: paid,
          asOf,
        }),
      };
    });
    const bucketKeys = ['NOT_DUE', '1_7', '8_30', '31_60', '61_90', 'OVER_90'] as const;
    const buckets = bucketKeys.map((key) => {
      const items = invoices.filter((item: any) => item.bucket === key);
      const amount = items.reduce(
        (sum: Decimal, item: any) => sum.plus(new Decimal(String(item.open_balance ?? '0'))),
        new Decimal(0),
      );
      return {
        bucket: key,
        label: agingBucketLabel(key),
        amount: money2(amount),
        count: items.length,
      };
    });
    return { as_of: asOf, buckets, invoices };
  });
}

export async function customerStatement(
  pool: Db,
  tenantId: string,
  customerId: string,
  filters: { from?: string; to?: string } = {},
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const customer = await client.query(
      'SELECT id, name FROM business_parties WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId],
    );
    if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    const from = filters.from ? dateOrError(filters.from, '') : '';
    const to = filters.to ? dateOrError(filters.to, '') : '';

    const invoiceRows = await client.query(
      `SELECT i.id, i.invoice_number, i.issue_date AS event_date, i.document_type,
              i.total, i.advance_applied, i.credited_amount, i.amount_paid, i.status,
              i.created_at
       FROM sales_invoices i
       WHERE i.tenant_id = $1 AND i.customer_id = $2
         AND i.status IN ('ISSUED','PARTIALLY_PAID','CREDITED')
         AND i.document_type <> 'SALES_CREDIT_NOTE'
         ${from ? 'AND i.issue_date >= $3::date' : ''}
         ${to ? `AND i.issue_date <= $${from ? '4' : '3'}::date` : ''}
       ORDER BY i.issue_date, i.created_at`,
      from && to
        ? [tenantId, customerId, from, to]
        : from
          ? [tenantId, customerId, from]
          : to
            ? [tenantId, customerId, to]
            : [tenantId, customerId],
    );

    interface StatementEvent {
      date: string;
      kind: 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT';
      number: string;
      description: string;
      amount: Decimal;
      sort: string;
      document_id: string;
    }
    const events: StatementEvent[] = [];
    for (const row of invoiceRows.rows as any[]) {
      const billed = new Decimal(String(row.total ?? '0'))
        .minus(new Decimal(String(row.advance_applied ?? '0')));
      events.push({
        date: String(row.issue_date),
        kind: 'INVOICE',
        number: String(row.invoice_number ?? ''),
        description: `Invoice ${String(row.invoice_number ?? row.id)}`,
        amount: billed,
        sort: '1',
        document_id: String(row.id),
      });
      const creditLinks = await client.query(
        `SELECT c.invoice_number, c.total, c.issue_date, c.created_at, l.created_at AS link_created_at
         FROM sales_invoice_credit_links l
         JOIN sales_invoices c ON c.id = l.credit_invoice_id AND c.tenant_id = l.tenant_id
         WHERE l.original_invoice_id = $1 AND l.tenant_id = $2`,
        [row.id, tenantId],
      );
      for (const credit of creditLinks.rows as any[]) {
        events.push({
          date: String(credit.issue_date),
          kind: 'CREDIT_NOTE',
          number: String(credit.invoice_number ?? ''),
          description: `Credit note ${String(credit.invoice_number ?? '')}`,
          amount: new Decimal(String(credit.total ?? '0')).negated(),
          sort: '3',
          document_id: String(row.id),
        });
      }
      const payments = await client.query(
        `SELECT p.amount, p.payment_date, p.reference, p.created_at
         FROM sales_invoice_payments p
         WHERE p.invoice_id = $1 AND p.tenant_id = $2
         ORDER BY p.payment_date, p.created_at`,
        [row.id, tenantId],
      );
      for (const payment of payments.rows as any[]) {
        events.push({
          date: String(payment.payment_date),
          kind: 'PAYMENT',
          number: String(payment.reference ?? ''),
          description: `Payment${payment.reference ? ` ${String(payment.reference)}` : ''}`,
          amount: new Decimal(String(payment.amount ?? '0')).negated(),
          sort: '2',
          document_id: String(row.id),
        });
      }
    }
    events.sort(
      (left, right) =>
        left.date.localeCompare(right.date)
        || left.sort.localeCompare(right.sort)
        || left.document_id.localeCompare(right.document_id),
    );
    let running = new Decimal(0);
    const lines = events.map((event) => {
      running = running.plus(event.amount);
      const positive = event.amount.greaterThanOrEqualTo(0);
      return {
        date: event.date,
        kind: event.kind,
        document_id: event.document_id,
        number: event.number,
        description: event.description,
        debit: positive ? money2(event.amount) : '0.00',
        credit: positive ? '0.00' : money2(event.amount.abs()),
        balance: money2(running),
      };
    });
    return {
      customer: customer.rows[0],
      lines,
      open_balance: money2(running.greaterThan(0) ? running : 0),
    };
  });
}

export async function customerBalance(
  pool: Db,
  tenantId: string,
  customerId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const customer = await client.query(
      'SELECT id, name FROM business_parties WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId],
    );
    if (!customer.rows[0]) throw new AppError(ErrorCodes.customerNotFound, 'Customer not found', 404);
    const issued = await client.query(
      `SELECT COALESCE(sum(GREATEST(0, i.total - i.advance_applied)),0)::text AS invoiced,
              COALESCE(sum(GREATEST(0, i.total - i.advance_applied - i.credited_amount - i.amount_paid)),0)::text AS open,
              COALESCE(sum(CASE WHEN i.due_date < current_date
                THEN GREATEST(0, i.total - i.advance_applied - i.credited_amount - i.amount_paid)
                ELSE 0 END),0)::text AS overdue
       FROM sales_invoices i
       WHERE i.tenant_id = $1 AND i.customer_id = $2
         AND i.status IN ('ISSUED','PARTIALLY_PAID')
         AND i.document_type <> 'SALES_CREDIT_NOTE'`,
      [tenantId, customerId],
    );
    const paid = await client.query(
      `SELECT COALESCE(sum(p.amount),0)::text AS paid
       FROM sales_invoice_payments p
       JOIN sales_invoices i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND i.customer_id = $2`,
      [tenantId, customerId],
    );
    const credited = await client.query(
      `SELECT COALESCE(sum(c.total),0)::text AS credited
       FROM sales_invoice_credit_links l
       JOIN sales_invoices o ON o.id = l.original_invoice_id AND o.tenant_id = l.tenant_id
       JOIN sales_invoices c ON c.id = l.credit_invoice_id AND c.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1 AND o.customer_id = $2`,
      [tenantId, customerId],
    );
    return {
      customer: customer.rows[0],
      total_invoiced: money2(new Decimal(String(issued.rows[0]?.invoiced ?? '0'))),
      paid: money2(new Decimal(String(paid.rows[0]?.paid ?? '0'))),
      credited: money2(new Decimal(String(credited.rows[0]?.credited ?? '0'))),
      open: money2(new Decimal(String(issued.rows[0]?.open ?? '0'))),
      overdue: money2(new Decimal(String(issued.rows[0]?.overdue ?? '0'))),
    };
  });
}

// ---------------------------------------------------------------------------
// Recurring template management.
// ---------------------------------------------------------------------------

export async function getRecurringTemplate(
  pool: Db,
  tenantId: string,
  templateId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const template = await client.query(
      `SELECT t.*, bp.name AS customer_name
       FROM recurring_invoice_templates t
       JOIN business_parties bp ON bp.id = t.customer_id AND bp.tenant_id = t.tenant_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [templateId, tenantId],
    );
    if (!template.rows[0]) {
      throw new AppError(ErrorCodes.invoiceNotFound, 'Recurring template not found', 404);
    }
    const lines = await client.query(
      `SELECT * FROM recurring_invoice_lines
       WHERE template_id = $1 ORDER BY line_number`,
      [template.rows[0].id],
    );
    return { ...template.rows[0], lines: lines.rows };
  });
}

export async function updateRecurringTemplate(
  pool: Db,
  tenantId: string,
  templateId: string,
  userId: string,
  input: {
    name?: string;
    frequency?: string;
    endDate?: string | null;
    language?: string;
    paymentTermsDays?: number;
    lines?: Array<{ description: string; quantity: string; unit?: string; unit_price: string; tax_code_id: string; discount_percent?: string }>;
  },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const existing = await client.query(
      'SELECT * FROM recurring_invoice_templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [templateId, tenantId],
    );
    if (!existing.rows[0]) {
      throw new AppError(ErrorCodes.invoiceNotFound, 'Recurring template not found', 404);
    }
    const frequency = String(input.frequency ?? existing.rows[0].frequency);
    if (!['MONTHLY', 'QUARTERLY', 'YEARLY'].includes(frequency)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid frequency', 400);
    }
    const language = String(input.language ?? existing.rows[0].language);
    if (!['fi', 'en', 'et'].includes(language)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid language', 400);
    }
    const paymentTermsDays = Number(input.paymentTermsDays ?? existing.rows[0].payment_terms_days);
    if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 3650) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid payment terms', 400);
    }
    const updated = await client.query(
      `UPDATE recurring_invoice_templates
       SET name = $3, frequency = $4, end_date = $5::date,
           language = $6, payment_terms_days = $7, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [
        templateId,
        tenantId,
        String(input.name ?? existing.rows[0].name),
        frequency,
        input.endDate === undefined ? existing.rows[0].end_date : input.endDate,
        language,
        paymentTermsDays,
      ],
    );
    if (Array.isArray(input.lines) && input.lines.length > 0) {
      await client.query(
        'DELETE FROM recurring_invoice_lines WHERE template_id = $1 AND tenant_id = $2',
        [templateId, tenantId],
      );
      let lineNumber = 1;
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO recurring_invoice_lines
             (tenant_id, template_id, line_number, description, quantity, unit, unit_price,
              discount_percent, tax_code_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tenantId, templateId, lineNumber, line.description, line.quantity, line.unit ?? '', line.unit_price, line.discount_percent ?? '0', line.tax_code_id],
        );
        lineNumber += 1;
      }
    }
    const templateRow = updated.rows[0];
    const lineRows = await client.query(
      `SELECT * FROM recurring_invoice_lines
       WHERE template_id = $1 ORDER BY line_number`,
      [templateId],
    );
    const customerName = await client.query(
      `SELECT bp.name FROM business_parties bp
       WHERE bp.id = $1 AND bp.tenant_id = $2`,
      [templateRow.customer_id, tenantId],
    );
    return { ...templateRow, customer_name: customerName.rows[0]?.name ?? '', lines: lineRows.rows };
  });
}

export async function setRecurringTemplateActive(
  pool: Db,
  tenantId: string,
  templateId: string,
  active: boolean,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const updated = await client.query(
      `UPDATE recurring_invoice_templates
       SET is_active = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [templateId, tenantId, active],
    );
    if (!updated.rows[0]) {
      throw new AppError(ErrorCodes.invoiceNotFound, 'Recurring template not found', 404);
    }
    return updated.rows[0];
  });
}

export async function deleteRecurringTemplate(
  pool: Db,
  tenantId: string,
  templateId: string,
): Promise<void> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const template = await client.query(
      'SELECT id FROM recurring_invoice_templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [templateId, tenantId],
    );
    if (!template.rows[0]) {
      throw new AppError(ErrorCodes.invoiceNotFound, 'Recurring template not found', 404);
    }
    const used = await client.query(
      `SELECT count(*)::int AS n FROM sales_invoices
       WHERE tenant_id = $1 AND source_recurring_template_id = $2`,
      [tenantId, templateId],
    );
    if (Number(used.rows[0]?.n ?? 0) > 0) {
      throw new AppError(
        ErrorCodes.invalidRequest,
        'Recurring template has generated invoices; disable it instead of deleting',
        409,
      );
    }
    await client.query(
      'DELETE FROM recurring_invoice_templates WHERE id = $1 AND tenant_id = $2',
      [templateId, tenantId],
    );
  });
}

// ---------------------------------------------------------------------------
// Document delivery: send history, reminder PDFs, invoice send and
// e-invoice readiness. Provider execution stays in the route layer; these
// helpers persist state and never claim success the provider did not confirm.
// ---------------------------------------------------------------------------

export interface SendStateInput {
  documentType: 'SALES_INVOICE' | 'SALES_CREDIT_NOTE' | 'ADVANCE_INVOICE' | 'SALES_REMINDER';
  documentId: string;
  channel: 'EMAIL' | 'E_INVOICE' | 'MANUAL_PDF';
  recipient?: string | null;
  subject?: string | null;
  provider: string;
  status: 'SENT' | 'FAILED' | 'QUEUED';
  error?: string | null;
}

export async function appendSendHistory(
  pool: Db,
  tenantId: string,
  userId: string,
  input: SendStateInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO document_send_history
         (tenant_id, document_type, document_id, channel, recipient, subject, provider,
          status, error, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        tenantId,
        input.documentType,
        input.documentId,
        input.channel,
        input.recipient ?? null,
        input.subject ?? null,
        input.provider,
        input.status,
        input.error ?? null,
        userId,
      ],
    );
    return result.rows[0];
  });
}

export async function listSendHistory(
  pool: Db,
  tenantId: string,
  filters: { documentType?: string; documentId?: string } = {},
): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filters.documentType) {
      values.push(filters.documentType);
      clauses.push(`document_type = $${values.length}`);
    }
    if (filters.documentId) {
      values.push(filters.documentId);
      clauses.push(`document_id = $${values.length}`);
    }
    const rows = await client.query(
      `SELECT * FROM document_send_history
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC LIMIT 200`,
      values,
    );
    return rows.rows;
  });
}

export async function setInvoiceDeliveryState(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  status: 'NOT_SENT' | 'SENT' | 'FAILED' | 'EINVOICE_READY' | 'PDF_ONLY',
): Promise<void> {
  return withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `UPDATE sales_invoices SET delivery_status = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId, status],
    ).then(() => undefined),
  );
}

export async function getSalesReminder(
  pool: Db,
  tenantId: string,
  reminderId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT r.*, i.invoice_number, i.due_date AS invoice_due_date,
              i.total, i.amount_paid, i.credited_amount, i.advance_applied,
              i.customer_snapshot
       FROM sales_reminders r
       JOIN sales_invoices i ON i.id = r.invoice_id AND i.tenant_id = r.tenant_id
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [reminderId, tenantId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Reminder not found', 404);
    return result.rows[0];
  });
}

export async function requestReminderPdf(
  pool: Db,
  tenantId: string,
  reminderId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const reminder = await client.query(
      `SELECT * FROM sales_reminders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [reminderId, tenantId],
    );
    if (!reminder.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Reminder not found', 404);
    if (reminder.rows[0].pdf_status === 'READY') return reminder.rows[0];
    await client.query(
      `UPDATE sales_reminders
       SET pdf_status = 'GENERATING', last_error = NULL
       WHERE id = $1 AND tenant_id = $2`,
      [reminderId, tenantId],
    );
    await appendOutboxInTransaction(client, tenantId, {
      eventType: 'SALES_REMINDER_PDF_REQUESTED',
      aggregateType: 'sales_reminder',
      aggregateId: reminderId,
      payload: { reminder_id: reminderId },
    });
    const updated = await client.query(
      `SELECT * FROM sales_reminders WHERE id = $1 AND tenant_id = $2`,
      [reminderId, tenantId],
    );
    return updated.rows[0];
  });
}

export async function getReminderPdfMetadata(
  pool: Db,
  tenantId: string,
  reminderId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM sales_reminders WHERE id = $1 AND tenant_id = $2`,
      [reminderId, tenantId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.invoiceNotFound, 'Reminder not found', 404);
    if (result.rows[0].pdf_status !== 'READY' || !result.rows[0].pdf_document_id) {
      throw new AppError(ErrorCodes.pdfNotReady, 'Reminder PDF is not ready', 409);
    }
    return result.rows[0];
  });
}

export async function markReminderSendResult(
  pool: Db,
  tenantId: string,
  reminderId: string,
  result: { status: 'SENT' | 'FAILED'; sentVia?: string; error?: string | null },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const updated = await client.query(
      `UPDATE sales_reminders
       SET status = $3, sent_via = $4, last_error = $5,
           sent_at = CASE WHEN $3 = 'SENT' THEN now() ELSE sent_at END
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [reminderId, tenantId, result.status, result.sentVia ?? null, result.error ?? null],
    );
    return updated.rows[0];
  });
}

/** Structured e-invoice export payload (readiness; no live operator yet). */
export async function exportEInvoicePayload(
  pool: Db,
  tenantId: string,
  invoiceId: string,
  userId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const invoice = await getInvoiceForPdf(client, tenantId, invoiceId);
    if (!['ISSUED', 'CREDITED', 'PARTIALLY_PAID'].includes(String(invoice.status))) {
      throw new AppError(ErrorCodes.invoiceNotDraft, 'E-invoice requires an issued invoice', 409);
    }
    const snapshot = invoice.customer_snapshot && typeof invoice.customer_snapshot === 'object'
      ? invoice.customer_snapshot
      : {};
    const address = String(snapshot.e_invoice_address ?? '');
    const operator = String(snapshot.e_invoice_operator ?? '');
    const ovt = String(snapshot.e_invoice_ovt ?? '');
    if (!address || (!operator && !ovt)) {
      throw new AppError(
        ErrorCodes.invalidRequest,
        'Customer e-invoice address and operator/OVT are required',
        400,
      );
    }
    const payload = {
      format: 'TILIVO_EINVOICE_V1',
      tenant_id: tenantId,
      invoice_id: invoiceId,
      invoice_number: invoice.invoice_number,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      currency: invoice.currency_code,
      language: invoice.language,
      payment_reference: invoice.payment_reference,
      seller: {
        name: invoice.seller_legal_name,
        business_id: invoice.seller_business_id,
        country: invoice.seller_country_code,
        iban: invoice.bank_iban ?? null,
        bic: invoice.bank_bic ?? null,
      },
      buyer: {
        name: snapshot.name ?? null,
        business_id: snapshot.business_id ?? null,
        vat_id: snapshot.vat_id ?? null,
        e_invoice_address: address,
        operator_id: operator,
        ovt: ovt || null,
      },
      lines: (invoice.lines ?? []).map((line: any) => ({
        description: line.description,
        quantity: line.quantity,
        unit: line.unit ?? null,
        unit_price: line.unit_price,
        discount_percent: line.discount_percent ?? '0',
        net_amount: line.net_amount,
        tax_code: line.tax_code_snapshot,
        tax_rate: line.tax_rate_snapshot,
        tax_amount: line.tax_amount,
        gross_amount: line.gross_amount,
      })),
      totals: {
        subtotal: invoice.subtotal,
        discount_amount: invoice.discount_amount,
        tax_total: invoice.tax_total,
        total: invoice.total,
        advance_applied: invoice.advance_applied,
        amount_due: money2(new Decimal(String(invoice.total ?? '0'))
          .minus(new Decimal(String(invoice.advance_applied ?? '0')))),
      },
    };
    const history = await client.query(
      `INSERT INTO document_send_history
         (tenant_id, document_type, document_id, channel, recipient, subject, provider,
          status, created_by)
       VALUES ($1, $2, $3, 'E_INVOICE', $4, $5, 'internal-export-v1', 'QUEUED', $6)
       RETURNING *`,
      [
        tenantId,
        String(invoice.document_type ?? 'SALES_INVOICE'),
        invoiceId,
        address,
        `E-invoice ${String(invoice.invoice_number)}`,
        userId,
      ],
    );
    await client.query(
      `UPDATE sales_invoices SET delivery_status = 'EINVOICE_READY', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    return { payload, history: history.rows[0], limitation: 'No live e-invoice operator; export is ready for outbound delivery.' };
  });
}
