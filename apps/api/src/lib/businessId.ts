/**
 * Finnish Business ID (Y-tunnus) handling.
 *
 * Format: NNNNNNN-C where the seven main digits are followed by a hyphen and
 * one check digit. The check digit is computed with weights
 * [7, 9, 10, 5, 8, 4, 2] over the seven digits:
 *   - remainder 0  -> check digit 0
 *   - remainder 1  -> the number is invalid
 *   - otherwise    -> 11 - remainder
 */
export const FINNISH_BUSINESS_ID_RE = /^\d{7}-\d$/;

const CHECK_WEIGHTS = [7, 9, 10, 5, 8, 4, 2] as const;

/**
 * Normalizes tolerant user input (whitespace, a leading FI prefix, a missing
 * hyphen) into the canonical `NNNNNNN-N` form. Returns null when the input is
 * not structurally parseable.
 */
export function normalizeFinnishBusinessId(input: string): string | null {
  const compact = String(input ?? '').trim().replace(/\s+/g, '').toUpperCase();
  if (!compact) return null;
  const withoutPrefix = compact.startsWith('FI') ? compact.slice(2) : compact;

  const digits = withoutPrefix;
  if (digits.includes('-')) {
    if (!/^\d{7}-\d$/.test(digits)) return null;
    return digits;
  }
  if (!/^\d{8}$/.test(digits)) return null;
  return `${digits.slice(0, 7)}-${digits[7]}`;
}

/**
 * Structural + checksum validation of a Finnish Business ID. Accepts tolerant
 * formatting such as `FI01120389`, `0112038-9`, `0112038 9`.
 */
export function isValidFinnishBusinessId(input: string): boolean {
  const normalized = normalizeFinnishBusinessId(input);
  if (!normalized || !FINNISH_BUSINESS_ID_RE.test(normalized)) return false;
  return checksumMatches(normalized);
}

/**
 * Returns the canonical Finnish VAT representation of a Business ID
 * (FI + eight digits, no hyphen), e.g. `0112038-9` -> `FI01120389`.
 * Returns null when the input is not a valid Finnish Business ID.
 */
export function formatFinnishVatId(input: string): string | null {
  const normalized = normalizeFinnishBusinessId(input);
  if (!normalized || !FINNISH_BUSINESS_ID_RE.test(normalized) || !checksumMatches(normalized)) return null;
  return `FI${normalized.slice(0, 7)}${normalized[8]}`;
}

/**
 * Parses a user supplied identifier into a canonical Business ID when it is a
 * valid Finnish Business ID (Y-tunnus), a Finnish VAT identifier (FI + 8
 * digits) or a structurally malformed-but-recognizable attempt. The caller
 * decides how to present validation failures.
 */
export function parseFinnishBusinessIdentifier(input: string): string | null {
  const normalized = normalizeFinnishBusinessId(input);
  if (!normalized || !FINNISH_BUSINESS_ID_RE.test(normalized)) return null;
  return checksumMatches(normalized) ? normalized : null;
}

function checksumMatches(businessId: string): boolean {
  let sum = 0;
  for (let index = 0; index < 7; index += 1) {
    sum += Number(businessId[index]) * CHECK_WEIGHTS[index]!;
  }
  const remainder = sum % 11;
  if (remainder === 1) return false;
  const expected = remainder === 0 ? 0 : 11 - remainder;
  return expected === Number(businessId[8]);
}
