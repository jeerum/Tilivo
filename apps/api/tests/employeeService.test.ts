import { describe, expect, it } from 'vitest';
import { isValidFinnishPersonalId, maskSensitive, normalizeFinnishPersonalId } from '../src/services/employeeService';

describe('employee registry helpers', () => {
  it('normalizes personal identity codes', () => expect(normalizeFinnishPersonalId('  131052-308T ')).toBe('131052-308T'));
  it('accepts supported Finnish identity formats', () => { expect(isValidFinnishPersonalId('131052-308T')).toBe(true); expect(isValidFinnishPersonalId('131052A308T')).toBe(true); });
  it('rejects malformed identity codes', () => { expect(isValidFinnishPersonalId('123')).toBe(false); expect(isValidFinnishPersonalId('131052-30XT')).toBe(false); });
  it('masks sensitive values and keeps suffix', () => { expect(maskSensitive('FI2112345600000785')).toBe('••••••••••••••0785'); expect(maskSensitive('1234', 2)).toBe('••34'); expect(maskSensitive(null)).toBeNull(); });
});
