import Decimal from 'decimal.js';

export const MONEY_DP = 8;
export const SALES_LANGUAGES = ['fi', 'en', 'et'] as const;
export type SalesLanguage = (typeof SALES_LANGUAGES)[number];

export type DeliveryMethod = 'EMAIL' | 'E_INVOICE' | 'PDF_MANUAL' | 'OTHER';
export type AgingBucket = 'NOT_DUE' | '1_7' | '8_30' | '31_60' | '61_90' | 'OVER_90';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const cents = (value: Decimal | string | number): Decimal =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function normalizeSalesLanguage(value: unknown): SalesLanguage {
  const raw = String(value ?? '').trim().toLowerCase();
  return SALES_LANGUAGES.includes(raw as SalesLanguage) ? (raw as SalesLanguage) : 'en';
}

export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.round((toMs - fromMs) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function todayString(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toDateString(value: unknown): string {
  if (value instanceof Date) return todayString(value);
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return raw.slice(0, 10);
}

/**
 * Allocates an invoice-level discount across line amounts before VAT.
 *
 * The allocation is deterministic: every line receives its exact proportional
 * share rounded down to cents; the residual cents are distributed one cent at
 * a time to the lines with the largest fractional remainders (ties resolved by
 * line order). The returned `allocated` array always sums to `amount`.
 */
export function allocateInvoiceDiscount(input: {
  lineNets: string[];
  discountPercent?: string | number;
  discountAmount?: string | number;
}): { percent: string; amount: string; allocated: string[] } {
  const lineNets = input.lineNets.map((value) => new Decimal(String(value)));
  if (lineNets.length === 0) {
    throw new Error('Invoice discount requires at least one line');
  }
  for (const net of lineNets) {
    if (net.lessThan(0)) throw new Error('Line net amount must not be negative');
  }
  const sum = lineNets.reduce((total, net) => total.plus(net), new Decimal(0));
  const percentValue = new Decimal(String(input.discountPercent ?? '0'));
  const amountValue = new Decimal(String(input.discountAmount ?? '0'));
  if (percentValue.lessThan(0) || percentValue.greaterThan(100)) {
    throw new Error('Invoice discount percent must be between 0 and 100');
  }
  if (amountValue.lessThan(0)) throw new Error('Invoice discount amount must not be negative');
  if (percentValue.greaterThan(0) && amountValue.greaterThan(0)) {
    throw new Error('Use either invoice discount percent or amount, not both');
  }
  const amount = percentValue.greaterThan(0)
    ? cents(sum.mul(percentValue).div(100))
    : amountValue;
  if (amount.greaterThan(sum)) throw new Error('Invoice discount exceeds the invoice net amount');
  if (amount.isZero()) {
    return {
      percent: percentValue.greaterThan(0) ? percentValue.toFixed(2) : '0.00',
      amount: '0.00',
      allocated: lineNets.map(() => '0.00'),
    };
  }
  if (sum.isZero()) throw new Error('Invoice discount requires a positive net amount');

  const exact = lineNets.map((net) => net.mul(amount).div(sum));
  const allocated = exact.map((value) => value.toDecimalPlaces(2, Decimal.ROUND_DOWN));
  let residual = amount.minus(allocated.reduce((total, value) => total.plus(value), new Decimal(0)));
  const fractions = exact.map((value, index) => ({
    index,
    fraction: value.minus(allocated[index]!).modulo(1),
  }));
  fractions.sort(
    (left, right) =>
      right.fraction.comparedTo(left.fraction) || left.index - right.index,
  );
  let cursor = 0;
  const oneCent = new Decimal('0.01');
  while (residual.greaterThanOrEqualTo(oneCent) && cursor < fractions.length) {
    const item = fractions[cursor]!;
    allocated[item.index] = allocated[item.index]!.plus(oneCent);
    residual = residual.minus(oneCent);
    cursor += 1;
  }
  if (cursor === fractions.length && residual.greaterThan(0)) {
    // Extreme sub-cent cases: give remaining to the first line deterministically.
    allocated[0] = allocated[0]!.plus(residual);
  }
  return {
    percent: percentValue.greaterThan(0) ? percentValue.toFixed(2) : '0.00',
    amount: amount.toFixed(2),
    allocated: allocated.map((value) => value.toFixed(2)),
  };
}

/** Open balance for an invoice after advances, credits and payments. */
export function openBalance(input: {
  total: string | number;
  advanceApplied?: string | number;
  credited?: string | number;
  paid?: string | number;
}): string {
  const balance = new Decimal(String(input.total))
    .minus(new Decimal(String(input.advanceApplied ?? '0')))
    .minus(new Decimal(String(input.credited ?? '0')))
    .minus(new Decimal(String(input.paid ?? '0')));
  return balance.greaterThan(0) ? balance.toFixed(2) : '0.00';
}

export function paymentStatusFor(input: {
  total: string | number;
  advanceApplied?: string | number;
  credited?: string | number;
  paid: string | number;
}): 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' {
  const balance = new Decimal(String(input.total))
    .minus(new Decimal(String(input.advanceApplied ?? '0')))
    .minus(new Decimal(String(input.credited ?? '0')))
    .minus(new Decimal(String(input.paid)));
  if (balance.lessThanOrEqualTo(0)) return 'PAID';
  return new Decimal(String(input.paid)).greaterThan(0) ? 'PARTIALLY_PAID' : 'UNPAID';
}

export function overdueDays(input: {
  dueDate: string;
  asOf?: string;
  advanceApplied?: string | number;
  credited: string | number;
  paid: string | number;
  total: string | number;
}): number {
  const balance = openBalance({
    total: input.total,
    advanceApplied: input.advanceApplied,
    credited: input.credited,
    paid: input.paid,
  });
  if (new Decimal(balance).lessThanOrEqualTo(0)) return 0;
  return Math.max(0, daysBetween(input.dueDate, input.asOf ?? todayString()));
}

export function agingBucketFor(input: {
  dueDate: string;
  asOf: string;
  advanceApplied?: string | number;
  credited: string | number;
  paid: string | number;
  total: string | number;
}): AgingBucket {
  if (new Decimal(openBalance(input)).lessThanOrEqualTo(0)) return 'NOT_DUE';
  const days = daysBetween(input.dueDate, input.asOf);
  if (days <= 0) return 'NOT_DUE';
  if (days <= 7) return '1_7';
  if (days <= 30) return '8_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return 'OVER_90';
}

export function agingBucketLabel(bucket: AgingBucket): string {
  switch (bucket) {
    case 'NOT_DUE': return 'Not due';
    case '1_7': return '1-7 days';
    case '8_30': return '8-30 days';
    case '31_60': return '31-60 days';
    case '61_90': return '61-90 days';
    case 'OVER_90': return '90+ days';
  }
}

/**
 * Late interest on the open balance from due date + grace days until as-of.
 * Uses a deterministic 365-day year and cents rounding. Rates are tenant /
 * customer configurable; when no rate is configured the result is zero.
 */
export function calculateLateInterest(input: {
  open: string | number;
  dueDate: string;
  asOf: string;
  annualRatePercent: string | number;
  graceDays?: number;
  enabled?: boolean;
}): { amount: string; days: number; startDate: string } {
  if (input.enabled === false) return { amount: '0.00', days: 0, startDate: input.dueDate };
  const rate = new Decimal(String(input.annualRatePercent ?? '0'));
  if (rate.lessThanOrEqualTo(0)) return { amount: '0.00', days: 0, startDate: input.dueDate };
  const grace = Math.max(0, Math.floor(Number(input.graceDays ?? 0)));
  const startDate = addDays(input.dueDate, grace);
  const days = Math.max(0, daysBetween(startDate, input.asOf));
  if (days === 0) return { amount: '0.00', days: 0, startDate };
  const open = new Decimal(String(input.open));
  const amount = cents(open.mul(rate).div(100).mul(days).div(365));
  return { amount: amount.toFixed(2), days, startDate };
}

export function recurringNextRun(frequency: 'MONTHLY' | 'QUARTERLY' | 'YEARLY', from: string): string {
  const date = new Date(`${from}T00:00:00Z`);
  const day = date.getUTCDate();
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  if (frequency === 'MONTHLY') month += 1;
  else if (frequency === 'QUARTERLY') month += 3;
  else year += 1;
  const targetMonthStart = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(day, lastDay));
  date.setTime(targetMonthStart.getTime());
  return date.toISOString().slice(0, 10);
}

export function recurringPeriodKey(templateId: string, nextDate: string): string {
  return `${templateId}:${nextDate}`;
}

/** Validates that a credit request stays within the remaining creditable total. */
export function assertCreditWithinRemaining(input: {
  creditTotal: string | number;
  originalTotal: string | number;
  advanceApplied?: string | number;
  alreadyCredited: string | number;
}): void {
  const remaining = new Decimal(String(input.originalTotal))
    .minus(new Decimal(String(input.advanceApplied ?? '0')))
    .minus(new Decimal(String(input.alreadyCredited)));
  if (new Decimal(String(input.creditTotal)).greaterThan(remaining.plus(0.001))) {
    throw new Error('Credit exceeds the remaining creditable amount');
  }
}

/**
 * Scales issued advance-invoice lines proportionally for allocation journals.
 *
 * Gross amounts are rounded down and residual cents distributed
 * deterministically so the allocated gross sums exactly. Net/VAT for each
 * line are derived from the line's frozen VAT rate (VAT engine semantics are
 * preserved: net = gross / (1 + rate/100), tax = gross - net).
 */
export function allocateAdvanceProportion(input: {
  allocationAmount: string | number;
  advanceTotal: string | number;
  lines: Array<{ gross: string; taxRate?: string | null }>;
}): Array<{ net: string; tax: string; gross: string }> {
  const allocation = new Decimal(String(input.allocationAmount));
  const advanceTotal = new Decimal(String(input.advanceTotal));
  if (advanceTotal.lessThanOrEqualTo(0)) {
    throw new Error('Advance invoice total must be positive');
  }
  if (allocation.greaterThan(advanceTotal.plus(0.001))) {
    throw new Error('Allocation exceeds the advance invoice total');
  }
  if (input.lines.length === 0) {
    throw new Error('Advance invoice has no lines');
  }
  const fraction = allocation.div(advanceTotal);
  const exact = input.lines.map((line) => new Decimal(String(line.gross)).mul(fraction));
  const gross = exact.map((value) => value.toDecimalPlaces(2, Decimal.ROUND_DOWN));
  let residual = allocation.minus(gross.reduce((total, value) => total.plus(value), new Decimal(0)));
  const fractions = exact.map((value, index) => ({
    index,
    fraction: value.minus(gross[index]!).modulo(1),
  }));
  fractions.sort(
    (left, right) =>
      right.fraction.comparedTo(left.fraction) || left.index - right.index,
  );
  const oneCent = new Decimal('0.01');
  let cursor = 0;
  while (residual.greaterThanOrEqualTo(oneCent) && cursor < fractions.length) {
    const item = fractions[cursor]!;
    gross[item.index] = gross[item.index]!.plus(oneCent);
    residual = residual.minus(oneCent);
    cursor += 1;
  }
  return gross.map((grossValue, index) => {
    const rate = new Decimal(String(input.lines[index]!.taxRate ?? '0'));
    const net = rate.greaterThan(0)
      ? cents(grossValue.div(rate.div(100).plus(1)))
      : grossValue;
    const tax = grossValue.minus(net);
    return {
      net: net.toFixed(2),
      tax: tax.toFixed(2),
      gross: grossValue.toFixed(2),
    };
  });
}
