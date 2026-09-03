import Decimal from 'decimal.js';

/**
 * v0.9 VAT / ALV engine — central tax rules.
 *
 * The engine deliberately never switches on a numeric rate. Tax codes carry
 * a semantic `treatment`, flags (reverse charge, intra-EU, export, import,
 * deductibility) and legal note templates; the engine resolves treatment +
 * direction + effective date into amounts, legs and reporting
 * classifications.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const TAX_TREATMENTS = {
  STANDARD: 'STANDARD',
  REDUCED: 'REDUCED',
  ZERO_RATED: 'ZERO_RATED',
  EXEMPT: 'EXEMPT',
  EU_GOODS_SUPPLY: 'EU_GOODS_SUPPLY',
  EU_GOODS_ACQUISITION: 'EU_GOODS_ACQUISITION',
  EU_SERVICE_SUPPLY: 'EU_SERVICE_SUPPLY',
  EU_SERVICE_ACQUISITION: 'EU_SERVICE_ACQUISITION',
  EXPORT: 'EXPORT',
  IMPORT: 'IMPORT',
  REVERSE_CHARGE: 'REVERSE_CHARGE',
  CONSTRUCTION_REVERSE_CHARGE: 'CONSTRUCTION_REVERSE_CHARGE',
  OWN_USE: 'OWN_USE',
} as const;

export type TaxTreatment = (typeof TAX_TREATMENTS)[keyof typeof TAX_TREATMENTS];

export const VAT_DIRECTIONS = {
  SALES: 'SALES',
  PURCHASE: 'PURCHASE',
  BOTH: 'BOTH',
} as const;

export type TaxDirection = (typeof VAT_DIRECTIONS)[keyof typeof VAT_DIRECTIONS];
export type TransactionDirection = 'SALES' | 'PURCHASE';

export type VatLegType =
  | 'OUTPUT_VAT'
  | 'INPUT_VAT'
  | 'RC_OUTPUT_VAT'
  | 'RC_INPUT_VAT'
  | 'REVENUE'
  | 'EXPENSE';

export const VAT_CLASSIFICATIONS = {
  DOMESTIC_OUTPUT_VAT: 'DOMESTIC_OUTPUT_VAT',
  DOMESTIC_INPUT_VAT: 'DOMESTIC_INPUT_VAT',
  ZERO_RATED: 'ZERO_RATED',
  EXEMPT: 'EXEMPT',
  EU_GOODS_SUPPLY: 'EU_GOODS_SUPPLY',
  EU_GOODS_ACQUISITION: 'EU_GOODS_ACQUISITION',
  EU_SERVICES_SUPPLY: 'EU_SERVICES_SUPPLY',
  EU_SERVICES_ACQUISITION: 'EU_SERVICES_ACQUISITION',
  EXPORT: 'EXPORT',
  IMPORT: 'IMPORT',
  REVERSE_CHARGE: 'REVERSE_CHARGE',
  CONSTRUCTION_RC: 'CONSTRUCTION_RC',
  OWN_USE: 'OWN_USE',
} as const;

export type VatClassification =
  (typeof VAT_CLASSIFICATIONS)[keyof typeof VAT_CLASSIFICATIONS];

export const TAX_TREATMENT_LIST: TaxTreatment[] = [
  TAX_TREATMENTS.STANDARD,
  TAX_TREATMENTS.REDUCED,
  TAX_TREATMENTS.ZERO_RATED,
  TAX_TREATMENTS.EXEMPT,
  TAX_TREATMENTS.EU_GOODS_SUPPLY,
  TAX_TREATMENTS.EU_GOODS_ACQUISITION,
  TAX_TREATMENTS.EU_SERVICE_SUPPLY,
  TAX_TREATMENTS.EU_SERVICE_ACQUISITION,
  TAX_TREATMENTS.EXPORT,
  TAX_TREATMENTS.IMPORT,
  TAX_TREATMENTS.REVERSE_CHARGE,
  TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
  TAX_TREATMENTS.OWN_USE,
];

export interface TaxCodeLike {
  id: string;
  code: string;
  name?: string;
  country_code?: string;
  rate: string | number;
  type?: string | null;
  treatment: TaxTreatment;
  direction: TaxDirection;
  reverse_charge?: boolean;
  intra_eu?: boolean;
  is_export?: boolean;
  is_import?: boolean;
  deductible_percent?: string | number;
  legal_notes?: Record<string, string> | null;
  reporting_mapping?: string | null;
  is_active?: boolean;
  is_system?: boolean;
}

export interface VatLeg {
  /** Ledger role: OUTPUT_VAT/INPUT_VAT for normal VAT, RC_* for self-assessed. */
  legType: VatLegType;
  /** Amount to post on this VAT leg (positive). */
  amount: string;
}

export interface VatCalculation {
  direction: TransactionDirection;
  treatment: TaxTreatment;
  classification: VatClassification;
  /** Statutory rate used (numeric rate from the tax code row). */
  rate: string;
  taxableBase: string;
  /** VAT that appears on the invoice (0 for RC/EU/export/import purchases). */
  invoiceTaxAmount: string;
  /** Self-assessed VAT that is not on the invoice (EU/RC/import purchases). */
  selfAssessedTaxAmount: string;
  /** Total VAT for reporting = invoice tax + self-assessed. */
  reportableTaxAmount: string;
  deductibleTax: string;
  nonDeductibleTax: string;
  /** Invoice gross amount (net + invoice VAT). */
  grossAmount: string;
  /** Net + non-deductible VAT when a purchase cost is capitalised. */
  expenseAmount: string;
  /** AP amount = net + invoice VAT (RC/EU/import keep net only). */
  payableAmount: string;
  /** VAT journal legs to create. */
  legs: VatLeg[];
  /** True when the treatment is a self-assessment (output + input legs). */
  selfAssessment: boolean;
  /** Human-readable legal note for the chosen invoice language. */
  legalNote: string;
}

const cents = (value: Decimal | string | number): Decimal =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function isTaxDirectionAllowed(
  rowDirection: TaxDirection,
  transactionDirection: TransactionDirection,
): boolean {
  return rowDirection === 'BOTH' || rowDirection === transactionDirection;
}

export function classifyTreatment(
  treatment: TaxTreatment,
  direction: TransactionDirection,
): VatClassification {
  switch (treatment) {
    case TAX_TREATMENTS.STANDARD:
    case TAX_TREATMENTS.REDUCED:
      return direction === 'SALES'
        ? VAT_CLASSIFICATIONS.DOMESTIC_OUTPUT_VAT
        : VAT_CLASSIFICATIONS.DOMESTIC_INPUT_VAT;
    case TAX_TREATMENTS.ZERO_RATED:
      return VAT_CLASSIFICATIONS.ZERO_RATED;
    case TAX_TREATMENTS.EXEMPT:
      return VAT_CLASSIFICATIONS.EXEMPT;
    case TAX_TREATMENTS.EU_GOODS_SUPPLY:
      return VAT_CLASSIFICATIONS.EU_GOODS_SUPPLY;
    case TAX_TREATMENTS.EU_GOODS_ACQUISITION:
      return VAT_CLASSIFICATIONS.EU_GOODS_ACQUISITION;
    case TAX_TREATMENTS.EU_SERVICE_SUPPLY:
      return VAT_CLASSIFICATIONS.EU_SERVICES_SUPPLY;
    case TAX_TREATMENTS.EU_SERVICE_ACQUISITION:
      return VAT_CLASSIFICATIONS.EU_SERVICES_ACQUISITION;
    case TAX_TREATMENTS.EXPORT:
      return VAT_CLASSIFICATIONS.EXPORT;
    case TAX_TREATMENTS.IMPORT:
      return VAT_CLASSIFICATIONS.IMPORT;
    case TAX_TREATMENTS.REVERSE_CHARGE:
      return VAT_CLASSIFICATIONS.REVERSE_CHARGE;
    case TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE:
      return VAT_CLASSIFICATIONS.CONSTRUCTION_RC;
    case TAX_TREATMENTS.OWN_USE:
      return VAT_CLASSIFICATIONS.OWN_USE;
    default:
      return VAT_CLASSIFICATIONS.DOMESTIC_OUTPUT_VAT;
  }
}

/** Legacy `type` -> v0.9 treatment used when old clients create codes. */
export function treatmentFromLegacyType(type: string): TaxTreatment {
  switch (String(type).toUpperCase()) {
    case 'ZERO':
    case 'ZERO_RATED':
      return TAX_TREATMENTS.ZERO_RATED;
    case 'EXEMPT':
      return TAX_TREATMENTS.EXEMPT;
    case 'REVERSE_CHARGE':
    case 'RC':
      return TAX_TREATMENTS.REVERSE_CHARGE;
    case 'REDUCED':
      return TAX_TREATMENTS.REDUCED;
    case 'EU_GOODS_SALE':
      return TAX_TREATMENTS.EU_GOODS_SUPPLY;
    case 'EU_GOODS_PURCHASE':
      return TAX_TREATMENTS.EU_GOODS_ACQUISITION;
    case 'EU_SERVICE_SALE':
      return TAX_TREATMENTS.EU_SERVICE_SUPPLY;
    case 'EU_SERVICE_PURCHASE':
      return TAX_TREATMENTS.EU_SERVICE_ACQUISITION;
    case 'EXPORT':
      return TAX_TREATMENTS.EXPORT;
    case 'IMPORT':
      return TAX_TREATMENTS.IMPORT;
    case 'CONSTRUCTION_REVERSE_CHARGE':
    case 'CONSTRUCTION_RC':
      return TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE;
    case 'OWN_USE':
      return TAX_TREATMENTS.OWN_USE;
    case 'VAT':
    default:
      return TAX_TREATMENTS.STANDARD;
  }
}

function normalizeLegalNotes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim()) out[key] = text;
  }
  return out;
}

export function legalNoteForLanguage(
  legalNotes: Record<string, string> | null | undefined,
  language?: string | null,
): string {
  const notes = normalizeLegalNotes(legalNotes);
  const lang = String(language ?? 'en').toLowerCase().slice(0, 2);
  return notes[lang] ?? notes.fi ?? notes.en ?? notes.et ?? '';
}

export function fillLegalNote(template: string, context: { businessId?: string | null; vatId?: string | null }): string {
  if (!template) return '';
  const buyerId = context.businessId || context.vatId || '—';
  const vatId = context.vatId || context.businessId || '—';
  return template
    .replace(/\{buyer_id\}/g, buyerId)
    .replace(/\{vat_id\}/g, vatId)
    .replace(/\{business_id\}/g, buyerId);
}

function leg(legType: VatLegType, amount: Decimal): VatLeg {
  return { legType, amount: amount.toFixed(2) };
}

/**
 * Central VAT calculation.
 *
 * Inputs are per-line: `netAmount` is the discounted line net in EUR. The
 * caller is responsible for quantity*unit price and discount rounding, which
 * the invoice services already perform deterministically.
 */
export function calculateVat(input: {
  direction: TransactionDirection;
  treatment: TaxTreatment;
  rate: string | number;
  netAmount: string | Decimal;
  deductiblePercent?: string | number | null;
  legalNotes?: Record<string, string> | null;
  language?: string | null;
}): VatCalculation {
  const direction = input.direction;
  const treatment = input.treatment;
  const net = cents(input.netAmount);
  if (net.isNegative()) {
    throw new Error('Net amount must not be negative');
  }
  const rate = new Decimal(input.rate);
  if (rate.isNegative()) throw new Error('Tax rate must not be negative');
  const classification = classifyTreatment(treatment, direction);
  const legalNote = legalNoteForLanguage(input.legalNotes, input.language);

  const standardVat = cents(net.mul(rate).div(100));
  const selfAssessmentTreatments: readonly TaxTreatment[] = [
      TAX_TREATMENTS.REVERSE_CHARGE,
      TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
      TAX_TREATMENTS.EU_GOODS_ACQUISITION,
      TAX_TREATMENTS.EU_SERVICE_ACQUISITION,
      TAX_TREATMENTS.IMPORT,
    ];
  const isSelfAssessment = direction === 'PURCHASE' && selfAssessmentTreatments.includes(treatment);

  const zeroRatedTreatments: readonly TaxTreatment[] = [
      TAX_TREATMENTS.ZERO_RATED,
      TAX_TREATMENTS.EXEMPT,
      TAX_TREATMENTS.EU_GOODS_SUPPLY,
      TAX_TREATMENTS.EU_SERVICE_SUPPLY,
      TAX_TREATMENTS.EXPORT,
      TAX_TREATMENTS.OWN_USE,
    ];
  const salesRcTreatments: readonly TaxTreatment[] = [
        TAX_TREATMENTS.REVERSE_CHARGE,
        TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
      ];
  const zeroRatedLike =
    zeroRatedTreatments.includes(treatment) ||
    (direction === 'SALES' && salesRcTreatments.includes(treatment));

  const domesticPurchaseTreatments: readonly TaxTreatment[] = [
    TAX_TREATMENTS.STANDARD,
    TAX_TREATMENTS.REDUCED,
  ];
  const isDomesticPurchase = direction === 'PURCHASE' && domesticPurchaseTreatments.includes(treatment);

  const invoiceTax = zeroRatedLike ? new Decimal(0) : isSelfAssessment ? new Decimal(0) : standardVat;
  const selfAssessed = isSelfAssessment ? standardVat : new Decimal(0);
  const reportable = invoiceTax.plus(selfAssessed);

  // Deductibility applies to purchase VAT (both normal input VAT and the
  // input side of a self-assessment). Sales VAT is never "deducted" here.
  let deductiblePercent = new Decimal(100);
  if (direction === 'PURCHASE' && input.deductiblePercent !== undefined && input.deductiblePercent !== null) {
    deductiblePercent = new Decimal(input.deductiblePercent);
  } else {
    const fromCode = input.deductiblePercent;
    if (fromCode !== undefined && fromCode !== null) deductiblePercent = new Decimal(fromCode);
  }
  if (deductiblePercent.lessThan(0) || deductiblePercent.greaterThan(100)) {
    throw new Error('Deductibility must be between 0 and 100 percent');
  }
  if (treatment === TAX_TREATMENTS.EXEMPT && direction === 'PURCHASE') {
    deductiblePercent = new Decimal(0);
  }

  const deductibleTax = direction === 'PURCHASE' ? cents(reportable.mul(deductiblePercent).div(100)) : new Decimal(0);
  const nonDeductibleTax = cents(reportable.minus(deductibleTax));

  const grossAmount = net.plus(invoiceTax);
  const payableAmount = isSelfAssessment ? net : grossAmount;
  const expenseAmount = net.plus(nonDeductibleTax);

  const legs: VatLeg[] = [];
  if (direction === 'SALES' && invoiceTax.greaterThan(0)) {
    legs.push(leg('OUTPUT_VAT', invoiceTax));
  } else if (isDomesticPurchase && reportable.greaterThan(0)) {
    if (deductibleTax.greaterThan(0)) legs.push(leg('INPUT_VAT', deductibleTax));
  } else if (isSelfAssessment && reportable.greaterThan(0)) {
    legs.push(leg('RC_OUTPUT_VAT', reportable));
    if (deductibleTax.greaterThan(0)) legs.push(leg('RC_INPUT_VAT', deductibleTax));
  }

  return {
    direction,
    treatment,
    classification,
    rate: rate.toString(),
    taxableBase: net.toFixed(2),
    invoiceTaxAmount: invoiceTax.toFixed(2),
    selfAssessedTaxAmount: selfAssessed.toFixed(2),
    reportableTaxAmount: reportable.toFixed(2),
    deductibleTax: deductibleTax.toFixed(2),
    nonDeductibleTax: nonDeductibleTax.toFixed(2),
    grossAmount: grossAmount.toFixed(2),
    expenseAmount: expenseAmount.toFixed(2),
    payableAmount: payableAmount.toFixed(2),
    legs,
    selfAssessment: isSelfAssessment,
    legalNote,
  };
}

export function taxCodeLabel(code: TaxCodeLike, language?: string | null): string {
  const name = String(code.name ?? code.code ?? '');
  const rate = new Decimal(code.rate).toFixed(code.treatment === TAX_TREATMENTS.ZERO_RATED ||
    code.treatment === TAX_TREATMENTS.EXEMPT ||
    code.treatment === TAX_TREATMENTS.EU_GOODS_SUPPLY ||
    code.treatment === TAX_TREATMENTS.EU_SERVICE_SUPPLY ||
    code.treatment === TAX_TREATMENTS.EXPORT ? 0 : 2);
  void language;
  const suffix = name && !name.includes('%') ? ` (${rate}%)` : '';
  return `${code.code} - ${name}${suffix}`;
}
