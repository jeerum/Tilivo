import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env';

function validEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('accepts a valid minimal environment', () => {
    const config = loadConfig(validEnv());
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(3000);
    expect(config.EXPOSE_DOCS).toBe(false);
  });

  it('coerces numeric and boolean values', () => {
    const config = loadConfig(validEnv({ PORT: '4100', EXPOSE_DOCS: 'true' }));
    expect(config.PORT).toBe(4100);
    expect(config.EXPOSE_DOCS).toBe(true);
  });

  it('rejects a missing database url', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(ConfigError);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(validEnv({ LOG_LEVEL: 'loud' }))).toThrow(/Invalid environment configuration/);
  });
});

