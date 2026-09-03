import { describe, expect, it } from 'vitest';
import { isValidFinnishPersonalId, maskSensitive, normalizeFinnishPersonalId } from '../src/services/employeeService';
import { calculateDurationMinutes } from '../src/services/timeTrackingService';

describe('employee registry helpers', () => {
  it('normalizes personal identity codes', () => expect(normalizeFinnishPersonalId('  131052-308T ')).toBe('131052-308T'));
  it('accepts supported Finnish identity formats', () => { expect(isValidFinnishPersonalId('131052-308T')).toBe(true); expect(isValidFinnishPersonalId('131052A308T')).toBe(true); });
  it('rejects malformed identity codes', () => { expect(isValidFinnishPersonalId('123')).toBe(false); expect(isValidFinnishPersonalId('131052-30XT')).toBe(false); });
  it('masks sensitive values and keeps suffix', () => { expect(maskSensitive('FI2112345600000785')).toBe('••••••••••••••0785'); expect(maskSensitive('1234', 2)).toBe('••34'); expect(maskSensitive(null)).toBeNull(); });
  it('calculates exact duration and supports duration-only entries', () => { expect(calculateDurationMinutes({ start_time: '2026-09-01T08:00:00+03:00', end_time: '2026-09-01T16:30:00+03:00' })).toBe(510); expect(calculateDurationMinutes({ duration_minutes: 480, start_time: 'bad' })).toBe(480); });
  it('supports midnight crossing without negative duration', () => expect(calculateDurationMinutes({ start_time: '2026-09-01T22:00:00+03:00', end_time: '2026-09-01T06:00:00+03:00' })).toBe(480));
});
