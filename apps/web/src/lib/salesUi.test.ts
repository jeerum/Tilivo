import { describe, expect, it } from 'vitest';
import {
  bucketTranslationKey,
  moneyFixed,
  openBalance,
  remainingCreditable,
} from './salesUi';

describe('sales UI helpers', () => {
  it('formats money deterministically', () => {
    expect(moneyFixed('1000')).toBe('1000.00');
    expect(moneyFixed(null)).toBe('0.00');
  });

  it('computes open balance with advances and credits', () => {
    expect(openBalance('1000', '100', '200', '300')).toBe('400.00');
    expect(openBalance('1000', '100', '900', '0')).toBe('0.00');
  });

  it('computes remaining creditable without payments', () => {
    expect(remainingCreditable('1240', '0', '620')).toBe('620.00');
    expect(remainingCreditable('1240', '1240', '0')).toBe('0.00');
  });

  it('maps aging buckets to translation keys', () => {
    expect(bucketTranslationKey('OVER_90')).toBe('bucketOver90');
    expect(bucketTranslationKey('NOT_DUE')).toBe('bucketNotDue');
    expect(bucketTranslationKey('1_7')).toBe('bucket1_7');
  });
});
