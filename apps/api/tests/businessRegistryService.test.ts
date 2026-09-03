import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/env';
import type { Db } from '../src/db/pool';
import { ErrorCodes } from '../src/lib/errors';
import { BusinessRegistryService } from '../src/services/businessRegistryService';
import type { BusinessRegistryProvider } from '../src/services/businessRegistryProvider';
import type { RegistryCompany } from '../src/services/businessRegistryTypes';

function fixtureCompany(name: string, businessId: string): RegistryCompany {
  return {
    provider: 'FAKE_PROVIDER',
    business_id: businessId,
    legal_name: name,
    vat_id: null,
    status: 'ACTIVE',
    status_code: '2',
    trade_register_status: '1',
    registration_date: '2020-01-01',
    end_date: null,
    company_form: null,
    address: { street: 'Testikatu 1', postal_box: null, postal_code: '00100', city: 'Helsinki', country_code: 'FI' },
    registers: {
      trade: { registered: true, code: '1_1' },
      vat: { registered: true, code: '6_80' },
      prepayment: { registered: false, code: null },
      employer: { registered: false, code: null },
    },
    fetched_at: new Date().toISOString(),
  };
}

/** Minimal in-memory stand-in for the business_registry_cache table. */
function fakeCacheDb(): Db {
  const store = new Map<string, { payload: unknown; fetched_at: string }>();
  return {
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes('INSERT INTO business_registry_cache')) {
        const key = `${String(values[0])}|${String(values[1])}|${String(values[2])}`;
        store.set(key, { payload: JSON.parse(String(values[3])), fetched_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM business_registry_cache')) {
        const key = `${String(values[0])}|${String(values[1])}|${String(values[2])}`;
        const row = store.get(key);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Db;
}

function config(rateLimit: number) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    LOG_LEVEL: 'silent',
    BUSINESS_REGISTRY_ENABLED: 'true',
    BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE: String(rateLimit),
  });
}

const context = { tenantId: 'tenant-1', userId: 'user-1' };

describe('BusinessRegistryService', () => {
  it('validates the Business ID before calling the provider', async () => {
    const provider: BusinessRegistryProvider = {
      name: 'FAKE_PROVIDER',
      searchByName: vi.fn(async () => []),
      getByBusinessId: vi.fn(async () => null),
    };
    const service = new BusinessRegistryService(fakeCacheDb(), provider, config(50));

    await expect(service.search({ query: '2204039-3' }, context)).rejects.toMatchObject({
      code: ErrorCodes.registryInvalidBusinessId,
    });
    expect(provider.getByBusinessId).not.toHaveBeenCalled();
  });

  it('serves repeat lookups from the cache without a second provider call', async () => {
    const provider: BusinessRegistryProvider = {
      name: 'FAKE_PROVIDER',
      searchByName: vi.fn(async ({ query }) => [fixtureCompany(query, '0112038-9')]),
      getByBusinessId: vi.fn(async (businessId: string) => fixtureCompany('Nokia Oyj', businessId)),
    };
    const service = new BusinessRegistryService(fakeCacheDb(), provider, config(50));

    const first = await service.search({ query: '0112038-9' }, context);
    expect(first.from_cache).toBe(false);
    expect(provider.getByBusinessId).toHaveBeenCalledTimes(1);

    const second = await service.search({ query: '0112038-9' }, context);
    expect(second.from_cache).toBe(true);
    expect(second.results[0]?.business_id).toBe('0112038-9');
    expect(provider.getByBusinessId).toHaveBeenCalledTimes(1);
  });

  it('rate limits external provider calls while still serving cached results', async () => {
    const provider: BusinessRegistryProvider = {
      name: 'FAKE_PROVIDER',
      searchByName: vi.fn(async ({ query }) => [fixtureCompany(query, '0112038-9')]),
      getByBusinessId: vi.fn(async (businessId: string) => fixtureCompany('Nokia Oyj', businessId)),
    };
    const service = new BusinessRegistryService(fakeCacheDb(), provider, config(1));

    await service.search({ query: '0112038-9' }, context);
    const cached = await service.search({ query: '0112038-9' }, context);
    expect(cached.from_cache).toBe(true);

    await expect(service.search({ query: 'Tampere Oy' }, context)).rejects.toMatchObject({
      code: ErrorCodes.registryRateLimited,
      statusCode: 429,
    });
  });

  it('fails cleanly when the registry is disabled', async () => {
    const provider: BusinessRegistryProvider = {
      name: 'FAKE_PROVIDER',
      searchByName: vi.fn(async () => []),
      getByBusinessId: vi.fn(async () => null),
    };
    const disabled = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      LOG_LEVEL: 'silent',
      BUSINESS_REGISTRY_ENABLED: 'false',
    });
    const service = new BusinessRegistryService(fakeCacheDb(), provider, disabled);

    await expect(service.search({ query: 'Nokia' }, context)).rejects.toMatchObject({
      code: ErrorCodes.registryDisabled,
    });
    expect(provider.searchByName).not.toHaveBeenCalled();
  });
});
