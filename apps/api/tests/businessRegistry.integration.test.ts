import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { AppError, ErrorCodes } from '../src/lib/errors';
import type { RegistryCompany } from '../src/services/businessRegistryTypes';
import type { BusinessRegistryProvider } from '../src/services/businessRegistryProvider';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

function companyFixture(businessId = '0112038-9', legalName = 'Nokia Oyj'): RegistryCompany {
  return {
    provider: 'FAKE_TEST_PROVIDER',
    business_id: businessId,
    legal_name: legalName,
    vat_id: businessId === '0112038-9' ? 'FI01120389' : null,
    status: 'ACTIVE',
    status_code: '2',
    trade_register_status: '1',
    registration_date: '1978-03-15',
    end_date: null,
    company_form: { code: '17', label_fi: null, label_en: 'Public limited company' },
    address: {
      street: 'Karakaari 7',
      postal_box: null,
      postal_code: '02610',
      city: 'Espoo',
      country_code: 'FI',
    },
    registers: {
      trade: { registered: true, code: '1_1' },
      vat: { registered: true, code: '6_80' },
      prepayment: { registered: true, code: '5_55' },
      employer: { registered: true, code: '7_41' },
    },
    fetched_at: new Date().toISOString(),
  };
}

describe.skipIf(!databaseUrl)('v0.7.5 business registry', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;
  let storageDir: string;
  const provider: BusinessRegistryProvider & {
    searchByName: ReturnType<typeof vi.fn>;
    getByBusinessId: ReturnType<typeof vi.fn>;
  } = {
    name: 'FAKE_TEST_PROVIDER',
    searchByName: vi.fn(async () => [companyFixture()]),
    getByBusinessId: vi.fn(async (businessId: string) => {
      const canonical = businessId === '0112038-9' ? businessId : null;
      return canonical ? companyFixture(canonical) : null;
    }),
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: storageDir,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
      BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE: '50',
    });
    app = await buildApp({ config, db: pool, registryProvider: provider });
    fixture = new SalesFixture(app, pool, 'regi');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    provider.searchByName.mockReset();
    provider.getByBusinessId.mockReset();
    provider.searchByName.mockImplementation(async () => [companyFixture()]);
    provider.getByBusinessId.mockImplementation(async (businessId: string) =>
      businessId === '0112038-9' ? companyFixture(businessId) : null,
    );
  });

  it('searches by company name and returns normalized registry companies', async () => {
    const auth = await fixture.setupOwner('Registry Name Search');
    const result = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=Nokia%20Oyj',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 200, 'name search');
    expect(result.body.searched_by).toBe('NAME');
    expect(result.body.provider).toBe('FAKE_TEST_PROVIDER');
    expect(result.body.results[0].business_id).toBe('0112038-9');
    expect(result.body.results[0].legal_name).toBe('Nokia Oyj');
    expect(provider.searchByName).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid Finnish Business ID before contacting the provider', async () => {
    const auth = await fixture.setupOwner('Registry Invalid Id');
    const result = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=2204039-3',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 400, 'invalid business id');
    expect(result.body.error.code).toBe('REG-001');
    expect(provider.getByBusinessId).not.toHaveBeenCalled();
  });

  it('returns an empty result set for a valid but unknown Business ID', async () => {
    const auth = await fixture.setupOwner('Registry Unknown Id');
    const result = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=0116297-6',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 200, 'unknown business id search');
    expect(result.body.searched_by).toBe('BUSINESS_ID');
    expect(result.body.results).toEqual([]);
    expect(provider.getByBusinessId).toHaveBeenCalledWith('0116297-6');
  });

  it('serves repeated lookups from the cache without another provider call', async () => {
    const auth = await fixture.setupOwner('Registry Cache');
    const first = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=0112038-9',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(first, 200, 'first lookup');
    expect(first.body.from_cache).toBe(false);
    expect(provider.getByBusinessId).toHaveBeenCalledTimes(1);

    const second = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=0112038-9',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(second, 200, 'cached lookup');
    expect(second.body.from_cache).toBe(true);
    expect(provider.getByBusinessId).toHaveBeenCalledTimes(1);
  });

  it('exact lookup endpoint returns 404 for an unknown valid Business ID', async () => {
    const auth = await fixture.setupOwner('Registry Exact NotFound');
    const result = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/companies/0116297-6',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 404, 'not found');
    expect(result.body.error.code).toBe('REG-002');
  });

  it('creates a customer from registry data and persists provenance metadata', async () => {
    const auth = await fixture.setupOwner('Registry Customer');
    const search = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=0112038-9',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const company = search.body.results[0] as RegistryCompany;

    const created = await fixture.request({
      method: 'POST',
      url: '/api/v1/customers',
      body: {
        name: company.legal_name,
        business_id: company.business_id,
        vat_id: company.vat_id,
        address_line1: company.address?.street,
        postal_code: company.address?.postal_code,
        city: company.address?.city,
        country_code: 'FI',
        registry_source: company.provider,
        registry_source_id: company.business_id,
        registry_fetched_at: company.fetched_at,
        registry_snapshot: company,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(created, 201, 'create customer');

    const customerId = created.body.customer.id as string;
    const fetched = await fixture.request({
      method: 'GET',
      url: `/api/v1/customers/${customerId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(fetched, 200, 'get customer');
    expect(fetched.body.customer.registry_source).toBe('FAKE_TEST_PROVIDER');
    expect(fetched.body.customer.registry_source_id).toBe('0112038-9');
    expect(fetched.body.customer.registry_snapshot.business_id).toBe('0112038-9');
    expect(fetched.body.customer.address_line1).toBe('Karakaari 7');
  });

  it('refreshes an existing supplier and can clear registry metadata', async () => {
    const auth = await fixture.setupOwner('Registry Supplier');
    const company = companyFixture();
    const created = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: {
        name: company.legal_name,
        business_id: company.business_id,
        vat_id: company.vat_id,
        address_line1: company.address?.street,
        postal_code: company.address?.postal_code,
        city: company.address?.city,
        country_code: 'FI',
        registry_source: company.provider,
        registry_source_id: company.business_id,
        registry_fetched_at: company.fetched_at,
        registry_snapshot: company,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(created, 201, 'create supplier');
    const supplierId = created.body.supplier.id as string;

    const refreshed = companyFixture();
    const updated = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/suppliers/${supplierId}`,
      body: {
        name: `${refreshed.legal_name} Edustus`,
        registry_source: refreshed.provider,
        registry_source_id: refreshed.business_id,
        registry_fetched_at: refreshed.fetched_at,
        registry_snapshot: refreshed,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(updated, 200, 'refresh supplier');
    expect(updated.body.supplier.registry_source_id).toBe('0112038-9');

    const cleared = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/suppliers/${supplierId}`,
      body: {
        registry_source: null,
        registry_source_id: null,
        registry_fetched_at: null,
        registry_snapshot: null,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(cleared, 200, 'clear supplier registry metadata');
    expect(cleared.body.supplier.registry_source).toBeNull();
    expect(cleared.body.supplier.registry_source_id).toBeNull();
    expect(cleared.body.supplier.registry_snapshot).toBeNull();
  });

  it('returns a structured unavailable error when the provider fails but manual entry still works', async () => {
    const auth = await fixture.setupOwner('Registry Provider Down');
    provider.searchByName.mockRejectedValueOnce(
      new AppError(ErrorCodes.registryUnavailable, 'Registry service is temporarily unavailable', 503),
    );
    const search = await fixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=ProviderDown%20Oy',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(search, 503, 'provider down search');
    expect(search.body.error.code).toBe('REG-003');

    const manual = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: { name: 'Manual Supplier Oy', business_id: '0112038-9', country_code: 'FI' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(manual, 201, 'manual supplier creation still works');
  });

  it('rate limits external provider calls per tenant', async () => {
    const storageDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-rate-'));
    const limitedConfig = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: storageDir2,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
      BUSINESS_REGISTRY_RATE_LIMIT_PER_MINUTE: '1',
    });
    const limitedApp = await buildApp({ config: limitedConfig, db: pool, registryProvider: provider });
    const limitedFixture = new SalesFixture(limitedApp, pool, 'regi-rate');
    const auth = await limitedFixture.setupOwner('Registry Rate Limit');

    const first = await limitedFixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=Alpha%20Oy',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(first, 200, 'first name search');
    const second = await limitedFixture.request({
      method: 'GET',
      url: '/api/v1/business-registry/search?q=Beta%20Oy',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(second, 429, 'rate limited second search');
    expect(second.body.error.code).toBe('REG-004');
    await limitedApp.close();
    fs.rmSync(storageDir2, { recursive: true, force: true });
  });
});
