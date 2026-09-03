import { describe, expect, it } from 'vitest';
import { centsToMoney, moneyToCents, sumMoney } from './money';

describe('money display helpers', () => {
  it('sums decimals without float drift', () => {
    expect(sumMoney(['0.1', '0.2'])).toBe('0.30');
    expect(sumMoney(['100.01', '200.02', '300.03'])).toBe('600.06');
  });

  it('handles large values', () => {
    expect(sumMoney(['999999999999.99', '0.01'])).toBe('1000000000000.00');
  });

  it('rounds fractional inputs to cents', () => {
    expect(moneyToCents('12.345')).toBe(0);
    expect(centsToMoney(moneyToCents('10'))).toBe('10.00');
  });
});
