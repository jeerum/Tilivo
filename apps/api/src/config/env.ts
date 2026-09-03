import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const environments = ['development', 'test', 'staging', 'production'] as const;
const emailDrivers = ['dev', 'noop'] as const;

const optionalInt = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : Number(value)),
    z.number().int().min(min).max(max),
  );

const toBoolean = (value: unknown, fallback: boolean) => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

const AppEnvSchema = z.object({
  NODE_ENV: z.enum(environments).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.preprocess(
    (value) => (value === undefined ? 3000 : Number(value)),
    z.number().int().min(1).max(65535),
  ),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => /^postgres(ql)?:\/\//i.test(url), 'DATABASE_URL must be a PostgreSQL connection URL'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  API_VERSION: z.string().min(1).default('0.2.0'),
  EXPOSE_DOCS: z.preprocess((value) => toBoolean(value, false), z.boolean()),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.preprocess((value) => toBoolean(value, false), z.boolean()),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION_COOKIE_NAME: z.string().min(1).default('tilivo_session'),
  CSRF_COOKIE_NAME: z.string().min(1).default('tilivo_csrf'),
  TRUST_PROXY_CIDRS: z
    .string()
    .min(1)
    .default('loopback,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
  EMAIL_DRIVER: z.enum(emailDrivers).default('noop'),
  EMAIL_DEV_OUTBOX: z.preprocess((value) => toBoolean(value, false), z.boolean()),
  TOTP_ENCRYPTION_KEY: z.string().default(''),
  DOCUMENT_STORAGE_DIR: z.string().min(1).default('/app/storage/documents'),
  BUSINESS_REGISTRY_ENABLED: z.preprocess(
    (value) => toBoolean(value, true),
    z.boolean(),
  ),
  BUSINESS_REGISTRY_BASE_URL: z
    .string()
    .url('BUSINESS_REGISTRY_BASE_URL must be a URL')
    .default('https://avoindata.prh.fi/opendata-ytj-api/v3'),
  BUSINESS_REGISTRY_TIMEOUT_MS: optionalInt(8000, 250, 60_000),
  BUSINESS_REGISTRY_CACHE_TTL_SECONDS: optionalInt(43_200, 60, 7 * 24 * 60 * 60),
  BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE: optionalInt(20, 1, 600),
  RATE_LIMIT_MAX: optionalInt(300, 10, 1_000_000),
  OCR_DRIVER: z.enum(['mock', 'none']).default('mock'),
});

export type AppConfig = z.infer<typeof AppEnvSchema>;

export class ConfigError extends Error {
  readonly code = 'CFG-001';

  constructor(message: string) {
    super(`Invalid environment configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(details);
  }

  const config = parsed.data;
  if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
    if (env.COOKIE_SECURE === undefined) {
      config.COOKIE_SECURE = true;
    }
    if (config.EMAIL_DRIVER === 'dev' || config.EMAIL_DEV_OUTBOX) {
      throw new ConfigError('EMAIL_DRIVER=dev / EMAIL_DEV_OUTBOX are only allowed in development/test');
    }
  }
  const totpKey = config.TOTP_ENCRYPTION_KEY;
  if (config.NODE_ENV !== 'test' && config.NODE_ENV !== 'development') {
    if (totpKey.length < 64) {
      throw new ConfigError('TOTP_ENCRYPTION_KEY must be at least 64 characters outside test/development');
    }
    if (totpKey.startsWith('dev-only-')) {
      throw new ConfigError('TOTP_ENCRYPTION_KEY must not use the development fallback in production');
    }
  }

  return config;
}
