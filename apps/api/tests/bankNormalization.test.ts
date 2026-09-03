import { describe, expect, it } from 'vitest';
import {
  bankTransactionFingerprint,
  isValidFinnishReference,
  isValidIban,
  isValidRfReference,
  normalizeIban,
  normalizePaymentReference,
} from '../src/lib/bankNormalization';

describe('bank normalization', () => {
  it('normalizes IBANs to uppercase without spaces', () => {
    expect(normalizeIban('fi21 1234 5600 0007 85')).toBe('FI2112345600000785');
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isValidIban('FI00 0000 0000 0000 00')).toBe(false);
  });

  it('validates Finnish payment references', () => {
    expect(isValidFinnishReference('12345672')).toBe(true);
    expect(isValidFinnishReference('1234 5672')).toBe(true);
    expect(isValidFinnishReference('123456789')).toBe(false);
  });

  it('validates RF references and normalizes them', () => {
    expect(isValidRfReference('RF18 5390 0754 7034')).toBe(true);
    expect(isValidRfReference('RF00 1234')).toBe(false);
    expect(normalizePaymentReference('RF18 5390 0754 7034')).toBe('RF18539007547034');
  });

  it('produces stable fingerprints', () => {
    const base = { bankAccountIban: 'FI2112345600000785', bookingDate: '2026-09-10', amount: '100.00', reference: '12345672', counterparty: 'Acme Oy' };
    expect(bankTransactionFingerprint(base)).toBe(bankTransactionFingerprint({ ...base, reference: '1234 5672' }));
    expect(bankTransactionFingerprint(base)).not.toBe(bankTransactionFingerprint({ ...base, amount: '100.01' }));
  });
});
