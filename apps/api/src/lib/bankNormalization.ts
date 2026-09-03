import { createHash } from 'node:crypto';
import { validateFiDomesticReference, validateRfCreditorReference } from './paymentReferences';

export function normalizeIban(value: string): string {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

/** ISO 13616 mod-97 checksum validation. */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (iban.length < 15 || iban.length > 34) return false;
  if (!/^[A-Z0-9]+$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    if (character >= 'A') {
      remainder = (remainder * 100 + (character.charCodeAt(0) - 55)) % 97;
    } else {
      remainder = (remainder * 10 + Number(character)) % 97;
    }
  }
  return remainder === 1;
}

export function normalizePaymentReference(value: string): string {
  return String(value ?? '').replace(/[\s-]/g, '');
}

/** Finnish domestic reference validation (7-3-1 weighting). */
export function isValidFinnishReference(value: string): boolean {
  const reference = normalizePaymentReference(value);
  return validateFiDomesticReference(reference);
}

export function normalizeRfReference(value: string): string {
  const reference = normalizePaymentReference(value);
  return reference.toUpperCase().replace(/^RF/, 'RF');
}

/** ISO 11649 RF reference validation (mod-98). */
export function isValidRfReference(value: string): boolean {
  const reference = normalizeRfReference(value);
  return validateRfCreditorReference(reference);
}

export function normalizeReferenceForMatching(value: string): string {
  const clean = normalizePaymentReference(value);
  return clean.toUpperCase();
}

export function bankTransactionFingerprint(input: {
  bankAccountIban: string;
  bookingDate: string;
  amount: string;
  reference?: string | null;
  counterparty?: string | null;
}): string {
  const raw = [
    normalizeIban(input.bankAccountIban),
    input.bookingDate,
    new Number(input.amount).toFixed(2),
    normalizeReferenceForMatching(input.reference ?? ''),
    String(input.counterparty ?? '').trim().toLowerCase(),
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}
