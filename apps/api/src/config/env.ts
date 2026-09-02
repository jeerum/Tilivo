import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const environments = ['development', 'test', 'staging', 'production'] as const;

const toBoolean = (value: unknown, fallback: boolean) => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

const AppEnvSchema = z.object({
  NODE_ENV: z.enum(environments).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z
    .preprocess((value) => (value === undefined ? 3000 : Number(value)), z.number().int().min(1).max(65535)),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => /^postgres(ql)?:\/\//i.test(url), 'DATABASE_URL must be a PostgreSQL connection URL'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  API_VERSION: z.string().min(1).default('0.1.0'),
  EXPOSE_DOCS: z.preprocess((value) => toBoolean(value, false), z.boolean()),
});

export type AppConfig = z.infer<typeof AppEnvSchema>;

export class ConfigError extends Error {
  readonly code = 'CFG-001';

  constructor(issues: z.ZodIssue[]) {
    const details = issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    super(`Invalid environment configuration: ${details}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues);
  }
  return parsed.data;
}

