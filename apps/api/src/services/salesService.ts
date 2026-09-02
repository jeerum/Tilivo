import Decimal from 'decimal.js';
import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { generatePaymentReference, type PaymentReferenceType } from '../lib/paymentReferences';
import { withTenantTransaction } from './tenantService';
import { createJournalDraftInTransaction, postJournalEntryInTransaction } from './accountingService';
import { appendOutboxInTransaction } from './integrationQueue';

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
    `SELECT id, code, name, rate, type, reporting_mapping, is_active
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
}

/**
 * Deterministic line arithmetic, rounded to cents:
 *   base = quantity * unit_price
 *   discount = round2(base * discount_percent / 100)
 *   net = round2(base - discount)
 *   tax = round2(net * tax_rate / 100)
 *   gross = net + tax
 */
export function computeLineAmounts(input: {
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  taxRate: string;
  taxType: string;
  reportingMapping?: string | null;
  revenueAccountId: string;
}): ComputedLine {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.unitPrice);
  const base = cents(quantity.mul(unitPrice));
  const discountPercent = new Decimal(input.discountPercent ?? '0');
  const discount = cents(base.mul(discountPercent).div(100));
  const net = cents(base.minus(discount));
  const rate = new Decimal(input.taxRate);
  const reverseCharge = input.taxType === 'REVERSE_CHARGE';
  const tax = reverseCharge ? new Decimal(0) : cents(net.mul(rate).div(100));
  const gross = net.plus(tax);
  return {
    net: net.toFixed(2),
    discount: discount.toFixed(2),
    tax: tax.toFixed(2),
    gross: gross.toFixed(2),
    taxRate: new Decimal(input.taxRate).toString(),
    taxType: input.taxType,
    reportingMapping: input.reportingMapping ?? null,
    revenueAccountId: input.revenueAccountId,
  };
}

async function validateInvoiceLines(
  client: DbClient,
  tenantId: string,
  input: InvoiceDraftInput,
  settings: any,
  issueDate: string,
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
        taxRate: String(taxCode.rate),
        taxType: String(taxCode.type),
        reportingMapping: taxCode.reporting_mapping ? String(taxCode.reporting_mapping) : null,
        revenueAccountId: String(revenueAccountId),
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
          is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, true)
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
          reporting_mapping_snapshot, tax_amount, gross_amount, revenue_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
  const computed = await validateInvoiceLines(client, tenantId, input, settings, issueDate);
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
    const invoice = await client.query(
      `INSERT INTO sales_invoices
         (tenant_id, company_id, customer_id, status, series_id, issue_date, due_date,
          currency_code, language, reference_type, customer_snapshot, subtotal, tax_total,
          total, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
    await client.query(
      `UPDATE sales_invoices
       SET company_id = $3, customer_id = $4, series_id = $5, issue_date = $6,
           due_date = $7, currency_code = $8, language = $9, reference_type = $10,
           subtotal = $11, tax_total = $12, total = $13, updated_at = now()
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
  const recomputed = lineRows.rows.map((row: any) => {
    const taxCode = taxMap.get(String(row.tax_code_id));
    if (!taxCode) {
      throw new AppError(
        ErrorCodes.invoiceTaxCodeInvalid,
        'Tax code is not active for the invoice date',
        400,
      );
    }
    return {
      row,
      computed: computeLineAmounts({
        quantity: String(row.quantity),
        unitPrice: String(row.unit_price),
        discountPercent: String(row.discount_percent ?? '0'),
        taxRate: String(taxCode.rate),
        taxType: String(taxCode.type),
        reportingMapping: taxCode.reporting_mapping ? String(taxCode.reporting_mapping) : null,
        revenueAccountId: String(row.revenue_account_id),
      }),
      taxCode,
    };
  });

  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (const item of recomputed) {
    await client.query(
      `UPDATE sales_invoice_lines
       SET net_amount = $3, tax_rate_snapshot = $4, tax_type_snapshot = $5,
           reporting_mapping_snapshot = $6, tax_amount = $7, gross_amount = $8,
           revenue_account_id = $9
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

  // Build journal lines. AR debit = total; revenue credits aggregated per
  // (account, tax code); VAT payable credits aggregated per tax code.
  const journalLines: Array<{
    accountId: string;
    description: string;
    debit: string;
    credit: string;
    taxCodeId: string | null;
    appliedTaxRate: string | null;
    taxSnapshot: string | null;
  }> = [];
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
  });

  const revenueGroups = new Map<string, { accountId: string; net: Decimal; taxCode: any }>();
  const taxGroups = new Map<string, { accountId: string; tax: Decimal; taxCode: any }>();
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
      });
    }
    if (tax.greaterThan(0)) {
      const taxKey = `${String(taxPayableAccount)}|${String(item.row.tax_code_id)}`;
      const existingTax = taxGroups.get(taxKey);
      if (existingTax) {
        existingTax.tax = existingTax.tax.plus(tax);
      } else {
        taxGroups.set(taxKey, {
          accountId: String(taxPayableAccount),
          tax,
          taxCode: item.taxCode,
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
         accounting_journal_entry_id = $9, issued_by = $10, issued_at = now(), updated_at = now()
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
): Promise<any> {
  return withTenantTransaction(pool, tenantId, (client) =>
    issueInvoiceInTransaction(client, tenantId, userId, invoiceId, {
      sourceType: 'SALES_INVOICE',
    }),
  );
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
          created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      `UPDATE sales_invoices SET status = 'CREDITED', credited_by_invoice_id = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'ISSUED'
       RETURNING *`,
      [originalInvoiceId, tenantId, creditId],
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
      invoices: rows.rows.map((row: any) => normalizeDateFields(row)),
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
            COALESCE(ss.tax_payable_account_id::text, '') AS tax_payable_account_id
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
