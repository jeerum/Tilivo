import { describe, expect, it } from 'vitest';
import {
  addDays,
  agingBucketFor,
  agingBucketLabel,
  allocateAdvanceProportion,
  allocateInvoiceDiscount,
  assertCreditWithinRemaining,
  calculateLateInterest,
  normalizeSalesLanguage,
  openBalance,
  paymentStatusFor,
  recurringNextRun,
} from '../src/services/salesMath';

const row = (total: string, advance = '0', credited = '0', paid = '0', dueDate = '2026-09-10') => ({
  total,
  advanceApplied: advance,
  credited,
  paid,
  dueDate,
});

describe('sales math helpers', () => {
  it('allocates a percentage invoice discount proportionally', () => {
    const result = allocateInvoiceDiscount({ lineNets: ['1000.00', '500.00'], discountPercent: '10' });
    expect(result.amount).toBe('150.00');
    expect(result.allocated.reduce((sum, value) => sum + Number(value), 0)).toBeCloseTo(150, 6);
  });

  it('allocates a fixed invoice discount exactly to the cent', () => {
    const result = allocateInvoiceDiscount({ lineNets: ['333.33', '333.33', '333.34'], discountAmount: '10.01' });
    const sum = result.allocated.reduce((total, value) => total + Number(value), 0);
    expect(sum).toBeCloseTo(10.01, 6);
  });

  it('is deterministic across repeated allocations', () => {
    const first = allocateInvoiceDiscount({ lineNets: ['100.00', '200.00', '300.00'], discountPercent: '7.5' });
    const second = allocateInvoiceDiscount({ lineNets: ['100.00', '200.00', '300.00'], discountPercent: '7.5' });
    expect(first.allocated).toEqual(second.allocated);
    expect(first.amount).toBe('45.00');
  });

  it('rejects invalid discount combinations', () => {
    expect(() => allocateInvoiceDiscount({ lineNets: ['100'], discountPercent: '10', discountAmount: '5' }))
      .toThrow(/not both/);
    expect(() => allocateInvoiceDiscount({ lineNets: ['100'], discountPercent: '200' })).toThrow(/between 0 and 100/);
    expect(() => allocateInvoiceDiscount({ lineNets: ['100'], discountAmount: '101' })).toThrow(/exceeds/);
  });

  it('computes deterministic late interest with grace days', () => {
    const interest = calculateLateInterest({
      open: '1000.00',
      dueDate: '2026-01-01',
      asOf: '2027-01-01',
      annualRatePercent: '10',
      graceDays: 0,
      enabled: true,
    });
    expect(interest.amount).toBe('100.00');
    expect(interest.days).toBe(365);

    const graced = calculateLateInterest({
      open: '1000.00',
      dueDate: '2026-01-01',
      asOf: '2026-01-10',
      annualRatePercent: '10',
      graceDays: 7,
      enabled: true,
    });
    expect(graced.amount).toBe('0.55');
    expect(graced.days).toBe(2);
    const noDays = calculateLateInterest({
      open: '1000.00',
      dueDate: '2026-01-01',
      asOf: '2026-01-07',
      annualRatePercent: '10',
      graceDays: 7,
      enabled: true,
    });
    expect(noDays.days).toBe(0);
    expect(noDays.amount).toBe('0.00');
  });

  it('returns zero interest when disabled or no rate', () => {
    expect(calculateLateInterest({
      open: '500',
      dueDate: '2026-01-01',
      asOf: '2026-02-01',
      annualRatePercent: '0',
      enabled: true,
    }).amount).toBe('0.00');
    expect(calculateLateInterest({
      open: '500',
      dueDate: '2026-01-01',
      asOf: '2026-02-01',
      annualRatePercent: '8',
      enabled: false,
    }).amount).toBe('0.00');
  });

  it('maps aging buckets at the required boundaries', () => {
    const base = { dueDate: '2026-09-10', asOf: '2026-09-11' };
    expect(agingBucketFor({ ...base, ...row('100') })).toBe('1_7');
    expect(agingBucketFor({ ...base, asOf: '2026-09-18', ...row('100') })).toBe('8_30');
    expect(agingBucketFor({ ...base, asOf: '2026-10-11', ...row('100') })).toBe('31_60');
    expect(agingBucketFor({ ...base, asOf: '2026-11-10', ...row('100') })).toBe('61_90');
    expect(agingBucketFor({ ...base, asOf: '2026-12-10', ...row('100') })).toBe('OVER_90');
    expect(agingBucketFor({ ...base, ...row('100', '0', '100') })).toBe('NOT_DUE');
    expect(agingBucketLabel('OVER_90')).toBe('90+ days');
  });

  it('computes open balances and payment status with advances and credits', () => {
    expect(openBalance(row('1000', '100', '200', '300'))).toBe('400.00');
    expect(paymentStatusFor({ ...row('1000', '100', '200', '0'), paid: '700' })).toBe('PAID');
    expect(paymentStatusFor({ ...row('1000'), paid: '400' })).toBe('PARTIALLY_PAID');
    expect(paymentStatusFor({ ...row('1000'), paid: '0' })).toBe('UNPAID');
  });

  it('keeps recurring schedules month/quarter/year aware', () => {
    expect(recurringNextRun('MONTHLY', '2026-01-31')).toBe('2026-02-28');
    expect(recurringNextRun('QUARTERLY', '2026-11-15')).toBe('2027-02-15');
    expect(recurringNextRun('YEARLY', '2028-02-29')).toBe('2029-02-28');
  });

  it('rejects over-crediting and allows exact remaining', () => {
    expect(() => assertCreditWithinRemaining({
      creditTotal: '500.01',
      originalTotal: '1000.00',
      alreadyCredited: '500.00',
    })).toThrow(/exceeds/);
    expect(() => assertCreditWithinRemaining({
      creditTotal: '500.00',
      originalTotal: '1000.00',
      advanceApplied: '100.00',
      alreadyCredited: '400.00',
    })).not.toThrow();
  });

  it('scales advance allocations and keeps gross/net/tax consistent', () => {
    const scaled = allocateAdvanceProportion({
      allocationAmount: '62.50',
      advanceTotal: '125.00',
      lines: [
        { gross: '100.00', taxRate: '25' },
        { gross: '25.00', taxRate: '25' },
      ],
    });
    const gross = scaled.reduce((sum, line) => sum + Number(line.gross), 0);
    const net = scaled.reduce((sum, line) => sum + Number(line.net), 0);
    const tax = scaled.reduce((sum, line) => sum + Number(line.tax), 0);
    expect(gross).toBeCloseTo(62.5, 6);
    expect(net + tax).toBeCloseTo(gross, 6);
    expect(() => allocateAdvanceProportion({
      allocationAmount: '126.00',
      advanceTotal: '125.00',
      lines: [{ gross: '125.00', taxRate: '25' }],
    })).toThrow(/exceeds/);
  });

  it('normalizes document language and adds days', () => {
    expect(normalizeSalesLanguage('ET')).toBe('et');
    expect(normalizeSalesLanguage('de')).toBe('en');
    expect(addDays('2026-09-03', 14)).toBe('2026-09-17');
  });
});
