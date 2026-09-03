/**
 * Client-side VAT display helpers. The backend VAT engine remains the
 * authoritative calculator; this module only mirrors the basic semantics so
 * the draft editors can show live net/VAT/gross previews with the same
 * "not a bare percentage" behaviour (RC/EU/export/exempt do not add VAT).
 */

export interface TaxCodeView {
  id: string;
  code: string;
  name: string;
  rate: string;
  type: string;
  direction: 'SALES' | 'PURCHASE' | 'BOTH';
  treatment: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  is_system: boolean;
  reverse_charge?: boolean;
  intra_eu?: boolean;
  is_export?: boolean;
  is_import?: boolean;
  deductible_percent?: string;
  reporting_mapping?: string | null;
  legal_notes?: Record<string, string>;
}

const DOMESTIC_TAXABLE = new Set(['STANDARD', 'REDUCED']);
const SELF_ASSESSED_PURCHASE = new Set([
  'REVERSE_CHARGE',
  'CONSTRUCTION_REVERSE_CHARGE',
  'EU_GOODS_ACQUISITION',
  'EU_SERVICE_ACQUISITION',
  'IMPORT',
]);

export function netCents(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function lineNetCents(input: {
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
}): number {
  const quantity = Number(input.quantity || '0');
  const unitPrice = Number(input.unitPrice || '0');
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return 0;
  const base = quantity * unitPrice * 100;
  const discountPercent = Number(input.discountPercent || '0');
  const discount = (base * discountPercent) / 100;
  return Math.round(base - discount);
}

export function isDomesticTaxable(code: TaxCodeView | undefined | null): boolean {
  return Boolean(code && DOMESTIC_TAXABLE.has(String(code.treatment)));
}

export function isSelfAssessedPurchase(code: TaxCodeView | undefined | null): boolean {
  return Boolean(code && code.direction === 'PURCHASE' && SELF_ASSESSED_PURCHASE.has(String(code.treatment)));
}

/**
 * VAT shown on the invoice (cents). RC/EU/export/exempt/zero-rated do not add
 * invoice VAT; self-assessed purchase VAT is booked only at posting.
 */
export function invoiceTaxCents(net: number, code: TaxCodeView | undefined | null): number {
  if (!code || !isDomesticTaxable(code)) return 0;
  const rate = Number(code.rate);
  if (!Number.isFinite(rate)) return 0;
  return Math.round((net * rate) / 100);
}

export function selfAssessedTaxCents(net: number, code: TaxCodeView | undefined | null): number {
  if (!code || !isSelfAssessedPurchase(code)) return 0;
  const rate = Number(code.rate);
  if (!Number.isFinite(rate)) return 0;
  return Math.round((net * rate) / 100);
}

export function deductibleTaxCents(
  net: number,
  code: TaxCodeView | undefined | null,
  deductiblePercent = '100',
): number {
  const total = invoiceTaxCents(net, code) + selfAssessedTaxCents(net, code);
  const percent = Number(deductiblePercent || '0');
  if (!Number.isFinite(percent)) return 0;
  return Math.round((total * percent) / 100);
}

export function taxRateLabel(code: TaxCodeView | undefined | null): string {
  if (!code) return '';
  const rate = Number(code.rate);
  if (!Number.isFinite(rate)) return '';
  if (['ZERO_RATED', 'EXEMPT', 'EU_GOODS_SUPPLY', 'EU_SERVICE_SUPPLY', 'EXPORT'].includes(String(code.treatment))) {
    return '0%';
  }
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2)}%`;
}
