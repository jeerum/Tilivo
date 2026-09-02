import { describe, expect, it } from 'vitest';
import {
  fiDomesticChecksum,
  generateFiDomesticReference,
  generatePaymentReference,
  generateRfCreditorReference,
  rfCheckDigits,
  validateFiDomesticReference,
  validatePaymentReference,
  validateRfCreditorReference,
} from '../src/lib/paymentReferences';

describe('Finnish domestic payment reference', () => {
  it('computes the standard 7-3-1 checksum vector', () => {
    // 1 2 3 4 5 6 7 -> weights from the right 7,3,1,7,3,1,7
    // 7*7 + 6*3 + 5*1 + 4*7 + 3*3 + 2*1 + 1*7 = 118 -> check digit 2
    expect(fiDomesticChecksum('1234567')).toBe(2);
    expect(generateFiDomesticReference('1234567')).toBe('12345672');
    expect(validateFiDomesticReference('12345672')).toBe(true);
  });

  it('handles leading zeros deterministically', () => {
    const reference = generateFiDomesticReference('000001');
    expect(validateFiDomesticReference(reference)).toBe(true);
    expect(reference).toMatch(/^[0-9]+$/);
    expect(generateFiDomesticReference('000001')).toBe(generateFiDomesticReference('000001'));
  });

  it('rejects invalid checksums and non numeric bases', () => {
    expect(validateFiDomesticReference('12345673')).toBe(false);
    expect(validateFiDomesticReference('123456')).toBe(false);
    expect(() => fiDomesticChecksum('12A45')).toThrow();
    expect(() => fiDomesticChecksum('')).toThrow();
  });

  it('round trips generated references', () => {
    for (const base of ['1', '42', '1234567', '100000000000000000']) {
      expect(validateFiDomesticReference(generateFiDomesticReference(base))).toBe(true);
    }
  });
});

describe('RF creditor reference (ISO 11649)', () => {
  it('matches the ISO reference vector RF18 5390 0754 7034', () => {
    // core 539007547034 with the RF00 suffix 271500 -> mod 97 = 80 -> check 18
    expect(rfCheckDigits('539007547034')).toBe('18');
    expect(generateRfCreditorReference('539007547034')).toBe('RF18539007547034');
    expect(validateRfCreditorReference('RF18 5390 0754 7034')).toBe(true);
    expect(validateRfCreditorReference('RF18539007547034')).toBe(true);
  });

  it('round trips generated references', () => {
    for (const core of ['1', '1234567', '539007547034', '900000000000000000000']) {
      const reference = generateRfCreditorReference(core);
      expect(reference).toMatch(/^RF[0-9]{2}[0-9]+$/);
      expect(validateRfCreditorReference(reference)).toBe(true);
    }
  });

  it('rejects wrong check digits and malformed input', () => {
    expect(validateRfCreditorReference('RF19 5390 0754 7034')).toBe(false);
    expect(validateRfCreditorReference('RF1853900754703')).toBe(false);
    expect(validateRfCreditorReference('RF18539007547034X')).toBe(false);
    expect(validateRfCreditorReference('18539007547034')).toBe(false);
  });
});

describe('invoice payment reference generator', () => {
  it('generates a deterministic FI reference from the padded running number', () => {
    const reference = generatePaymentReference('FI_DOMESTIC', '000001');
    expect(validatePaymentReference('FI_DOMESTIC', reference)).toBe(true);
    expect(reference).toMatch(/^[0-9]+$/);
  });

  it('generates an RF reference from the same base', () => {
    const reference = generatePaymentReference('RF', '000001');
    expect(validatePaymentReference('RF', reference)).toBe(true);
    expect(reference?.startsWith('RF')).toBe(true);
  });

  it('returns null for the NONE type', () => {
    expect(generatePaymentReference('NONE', '000001')).toBeNull();
    expect(validatePaymentReference('NONE', null)).toBe(true);
    expect(validatePaymentReference('NONE', '12345')).toBe(false);
  });
});
