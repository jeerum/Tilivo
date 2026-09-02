/**
 * Payment reference providers.
 *
 * Both implementations are pure functions: no invoice numbering state, no
 * random input and no dependency on the database. An invoice issue flow calls
 * generate() with a deterministic base (the invoice's padded running number).
 */

export type PaymentReferenceType = 'FI_DOMESTIC' | 'RF' | 'NONE';

const FI_WEIGHTS = [7, 3, 1] as const;

function onlyDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

/**
 * Finnish domestic reference (viitenumero) checksum, weights 7-3-1 applied
 * from the right-most digit. The check digit is the smallest number that
 * makes the total divisible by ten, encoded as (10 - sum % 10) % 10.
 */
export function fiDomesticChecksum(base: string): number {
  const digits = base.replace(/\s+/g, '');
  if (!onlyDigits(digits)) {
    throw new Error('FI domestic reference base must contain only digits');
  }
  if (digits.length === 0 || digits.length > 18) {
    throw new Error('FI domestic reference base must contain 1-18 digits');
  }
  let sum = 0;
  let weightIndex = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    sum += digit * FI_WEIGHTS[weightIndex % FI_WEIGHTS.length]!;
    weightIndex += 1;
  }
  return (10 - (sum % 10)) % 10;
}

/** Generate a full Finnish domestic reference from a numeric base. */
export function generateFiDomesticReference(base: string): string {
  const digits = base.replace(/\s+/g, '');
  return `${digits}${fiDomesticChecksum(digits)}`;
}

/** Validate a full Finnish domestic reference (numbers + checksum). */
export function validateFiDomesticReference(reference: string): boolean {
  const digits = reference.replace(/\s+/g, '');
  if (!onlyDigits(digits) || digits.length < 2 || digits.length > 19) return false;
  const base = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  return fiDomesticChecksum(base) === check;
}

/**
 * ISO 11649 RF creditor reference. Check digits are derived from the numeric
 * core followed by "RF00", then 98 - (value mod 97).
 */
export function rfCheckDigits(core: string): string {
  const digits = core.replace(/\s+/g, '');
  if (!onlyDigits(digits) || digits.length < 1 || digits.length > 21) {
    throw new Error('RF reference core must contain 1-21 digits');
  }
  const value = BigInt(`${digits}271500`);
  const remainder = value % 97n;
  const check = 98n - remainder;
  return check.toString().padStart(2, '0');
}

/** Generate a full RF creditor reference from a numeric core. */
export function generateRfCreditorReference(core: string): string {
  const digits = core.replace(/\s+/g, '');
  return `RF${rfCheckDigits(digits)}${digits}`;
}

/** Validate a full RF creditor reference ("RFxx" + digits). */
export function validateRfCreditorReference(reference: string): boolean {
  const normalized = reference.replace(/\s+/g, '').toUpperCase();
  if (!/^RF[0-9]{2}[0-9]+$/.test(normalized)) return false;
  const check = normalized.slice(2, 4);
  const core = normalized.slice(4);
  if (core.length < 1 || core.length > 21) return false;
  try {
    return rfCheckDigits(core) === check;
  } catch {
    return false;
  }
}

/**
 * Reference used for invoice payments. The base is the running sequence
 * number from the invoice number series, padded the same way as the invoice
 * number itself.
 */
export function generatePaymentReference(
  type: PaymentReferenceType,
  paddedRunningNumber: string,
): string | null {
  const digits = paddedRunningNumber.replace(/\s+/g, '');
  if (type === 'NONE') return null;
  if (!onlyDigits(digits) || digits.length === 0) {
    throw new Error('Invoice running number must be numeric for payment reference generation');
  }
  if (type === 'RF') {
    return generateRfCreditorReference(digits);
  }
  return generateFiDomesticReference(digits);
}

export function validatePaymentReference(
  type: PaymentReferenceType,
  reference: string | null,
): boolean {
  if (type === 'NONE') return reference === null || reference === '';
  if (!reference) return false;
  if (type === 'RF') return validateRfCreditorReference(reference);
  return validateFiDomesticReference(reference);
}
