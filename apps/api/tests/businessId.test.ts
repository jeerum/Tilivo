import { describe, expect, it } from 'vitest';
import {
  formatFinnishVatId,
  isValidFinnishBusinessId,
  normalizeFinnishBusinessId,
  parseFinnishBusinessIdentifier,
} from '../src/lib/businessId';

describe('Finnish Business ID utilities', () => {
  it('normalizes tolerant user formatting', () => {
    expect(normalizeFinnishBusinessId('0112038-9')).toBe('0112038-9');
    expect(normalizeFinnishBusinessId(' 0112038 - 9 ')).toBe('0112038-9');
    expect(normalizeFinnishBusinessId('FI01120389')).toBe('0112038-9');
    expect(normalizeFinnishBusinessId('01120389')).toBe('0112038-9');
  });

  it('validates structure and the modulus-11 check digit', () => {
    expect(isValidFinnishBusinessId('0112038-9')).toBe(true);
    expect(isValidFinnishBusinessId('FI01120389')).toBe(true);
    // 2204039-3 fails the check digit (expected 6).
    expect(isValidFinnishBusinessId('2204039-3')).toBe(false);
    expect(isValidFinnishBusinessId('123456')).toBe(false);
    expect(isValidFinnishBusinessId('12345678')).toBe(false);
    expect(isValidFinnishBusinessId('abc')).toBe(false);
    expect(isValidFinnishBusinessId('')).toBe(false);
  });

  it('returns null for structurally unparseable input', () => {
    expect(normalizeFinnishBusinessId('Nokia Oyj')).toBeNull();
    expect(normalizeFinnishBusinessId('')).toBeNull();
    expect(normalizeFinnishBusinessId('1234-5678')).toBeNull();
  });

  it('formats a Finnish VAT identifier from a Business ID', () => {
    expect(formatFinnishVatId('0112038-9')).toBe('FI01120389');
    expect(formatFinnishVatId('FI01120389')).toBe('FI01120389');
    expect(formatFinnishVatId('2204039-3')).toBeNull();
  });

  it('parses only identifiers with a valid check digit', () => {
    expect(parseFinnishBusinessIdentifier('0112038-9')).toBe('0112038-9');
    expect(parseFinnishBusinessIdentifier('2204039-3')).toBeNull();
    expect(parseFinnishBusinessIdentifier('Nokia')).toBeNull();
  });
});
