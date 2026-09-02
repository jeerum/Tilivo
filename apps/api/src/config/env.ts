import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const environments = ['development', 'test', 'staging', 'production'] as const;
const emailDrivers = ['dev', 'noop'] as const;

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
  EMAIL_DRIVER: z.enum(emailDrivers).default('noop'),
  EMAIL_DEV_OUTBOX: z.preprocess((value) => toBoolean(value, false), z.boolean()),
  TOTP_ENCRYPTION_KEY: z.string().default(''),
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
