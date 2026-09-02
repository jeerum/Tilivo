import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 320 && EMAIL_REGEX.test(email);
}

export function randomToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newTokenPair(byteLength = 32): { token: string; hash: string } {
  const token = randomToken(byteLength);
  return { token, hash: hashToken(token) };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const ARGON2_PARAMS = {
  iterations: 3,
  parallelism: 1,
  memorySize: 32768, // KiB = 32 MiB
  hashLength: 32,
};

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  return argon2Verify({ password, hash: encodedHash });
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export interface TotpOptions {
  timestamp?: number;
  period?: number;
  digits?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

function hotp(secretBytes: Uint8Array, counter: bigint, digits: number, algorithm: 'sha1' | 'sha256' | 'sha512'): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac(algorithm, Buffer.from(secretBytes)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpForSecret(
  secret: string | Uint8Array,
  { timestamp = Date.now(), period = 30, digits = 6, algorithm = 'sha1' }: TotpOptions = {},
): string {
  const secretBytes = typeof secret === 'string' ? base32Decode(secret) : secret;
  const counter = BigInt(Math.floor(timestamp / 1000 / period));
  return hotp(secretBytes, counter, digits, algorithm);
}

export function verifyTotp(secret: string, code: string, options: TotpOptions = {}): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const timestamp = options.timestamp ?? Date.now();
  const period = options.period ?? 30;
  for (const offset of [0, -period, period]) {
    const candidate = totpForSecret(secret, { ...options, timestamp: timestamp + offset * 1000 });
    if (constantTimeEqualHex(
      Buffer.from(candidate).toString('hex'),
      Buffer.from(code).toString('hex'),
    )) {
      return true;
    }
  }
  return false;
}

export function otpauthUri(secret: string, accountName: string, issuer = 'Tilivo'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(envelope: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const [version, ivB64, tagB64, dataB64] = envelope.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unsupported encrypted secret envelope');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(16);
    const groups: string[] = [];
    for (let g = 0; g < 4; g += 1) {
      let group = '';
      for (let c = 0; c < 4; c += 1) {
        group += RECOVERY_ALPHABET[bytes[g * 4 + c]! % RECOVERY_ALPHABET.length];
      }
      groups.push(group);
    }
    codes.push(groups.join('-'));
  }
  return codes;
}
