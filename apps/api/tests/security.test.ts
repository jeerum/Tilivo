import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  randomToken,
  totpForSecret,
  verifyPassword,
} from '../src/lib/security';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

describe('password hashing (argon2id)', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
  });

  it('produces a different hash for the same password because of the salt', async () => {
    const first = await hashPassword('same password value');
    const second = await hashPassword('same password value');
    expect(first).not.toBe(second);
  });
});

describe('tokens', () => {
  it('creates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
  });

  it('hashes tokens deterministically and never stores the raw value', () => {
    const token = randomToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });
});

describe('email normalization', () => {
  it('trims and lowercases email addresses', () => {
    expect(normalizeEmail('  Test.User@Example.COM ')).toBe('test.user@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('valid@example.com')).toBe(true);
  });
});

describe('TOTP (RFC 6238 SHA1 vectors)', () => {
  // RFC 6238 test secret: ASCII "12345678901234567890"
  const secret = Uint8Array.from(Buffer.from('12345678901234567890', 'ascii'));

  it('matches known TOTP values', () => {
    expect(totpForSecret(secret, { timestamp: 59_000, digits: 8 })).toBe('94287082');
    expect(totpForSecret(secret, { timestamp: 1_111_111_109_000, digits: 8 })).toBe('07081804');
    expect(totpForSecret(secret, { timestamp: 1_111_111_111_000, digits: 8 })).toBe('14050471');
    expect(totpForSecret(secret, { timestamp: 1_234_567_890_000, digits: 8 })).toBe('89005924');
  });

  it('verifies a valid code and rejects invalid ones', () => {
    const generated = totpForSecret(secret, { timestamp: 1_234_567_890_000, digits: 8 });
    expect(generated).toHaveLength(8);
    expect(generated).not.toBe('00000000');
  });
});

describe('recovery codes and secret encryption', () => {
  it('generates unique recovery codes in a usable format', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('encrypts and decrypts secrets with AES-256-GCM envelope', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP', TEST_ENCRYPTION_KEY);
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(decryptSecret(encrypted, TEST_ENCRYPTION_KEY)).toBe('JBSWY3DPEHPK3PXP');
  });
});
