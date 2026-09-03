import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/env';
import { loadConfig } from '../src/config/env';
import { ErrorCodes } from '../src/lib/errors';
import { createPrhYtjRegistryProvider } from '../src/services/prhYtjRegistryProvider';

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    LOG_LEVEL: 'silent',
    BUSINESS_REGISTRY_BASE_URL: 'https://prh.test/opendata-ytj-api/v3',
    BUSINESS_REGISTRY_TIMEOUT_MS: '2000',
    ...overrides,
  });
}

const nokiaPayload = {
  totalResults: 1,
  companies: [
    {
      businessId: { value: '0112038-9', registrationDate: '1978-03-15', source: '3' },
      names: [
        { name: 'Nokia Oyj', type: '1', registrationDate: '1997-09-01', version: 1, source: '1' },
        {
          name: 'Oy Nokia Ab',
          type: '1',
          registrationDate: '1966-06-10',
          endDate: '1997-08-31',
          version: 2,
          source: '1',
        },
        { name: 'Nokia Corporation', type: '2', registrationDate: '1997-09-01', version: 1, source: '1' },
      ],
      companyForms: [
        {
          type: '17',
          descriptions: [
            { languageCode: '1', description: 'Julkinen osakeyhtiö' },
            { languageCode: '3', description: 'Public limited company' },
          ],
          registrationDate: '1997-09-01',
          version: 1,
          source: '1',
        },
      ],
      registeredEntries: [
        { type: '1', descriptions: [], registrationDate: '1896-12-19', register: '1', authority: '2' },
        { type: '55', descriptions: [], registrationDate: '1995-03-01', register: '5', authority: '1' },
        { type: '80', descriptions: [], registrationDate: '1994-06-01', register: '6', authority: '1' },
        { type: '41', descriptions: [], registrationDate: '1944-01-01', register: '7', authority: '1' },
      ],
      addresses: [
        {
          type: 1,
          street: 'Karakaari',
          postCode: '02610',
          postOffices: [{ city: 'ESPOO', languageCode: '1', municipalityCode: '049' }],
          buildingNumber: '7',
          registrationDate: '2019-07-01',
          source: '0',
        },
      ],
      tradeRegisterStatus: '1',
      status: '2',
      registrationDate: '1896-12-19',
      lastModified: '2026-08-19T10:04:06',
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PRH YTJ v3 registry provider', () => {
  it('maps and normalizes a live-shaped company response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(nokiaPayload));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createPrhYtjRegistryProvider(makeConfig());

    const companies = await provider.searchByName({ query: 'Nokia Oyj', limit: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/companies?name=');
    expect(companies).toHaveLength(1);
    const company = companies[0]!;
    expect(company.provider).toBe('PRH_YTJ_V3');
    expect(company.business_id).toBe('0112038-9');
    expect(company.legal_name).toBe('Nokia Oyj');
    expect(company.vat_id).toBe('FI01120389');
    expect(company.status).toBe('ACTIVE');
    expect(company.status_code).toBe('2');
    expect(company.trade_register_status).toBe('1');
    expect(company.registration_date).toBe('1896-12-19');
    expect(company.company_form?.label_en).toBe('Public limited company');
    expect(company.address?.street).toBe('Karakaari 7');
    expect(company.address?.postal_code).toBe('02610');
    expect(company.address?.city).toBe('ESPOO');
    expect(company.address?.country_code).toBe('FI');
    expect(company.registers.trade.registered).toBe(true);
    expect(company.registers.vat.registered).toBe(true);
    expect(company.registers.prepayment.registered).toBe(true);
    expect(company.registers.employer.registered).toBe(true);
    expect(company.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns an empty list when the provider has no results', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ totalResults: 0, companies: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createPrhYtjRegistryProvider(makeConfig());

    const companies = await provider.searchByName({ query: 'No Such Oy' });
    expect(companies).toEqual([]);
    expect(await provider.getByBusinessId('0112038-9')).toBeNull();
  });

  it('exact lookup encodes the canonical Business ID', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(nokiaPayload));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createPrhYtjRegistryProvider(makeConfig());

    const company = await provider.getByBusinessId('0112038-9');
    expect(company?.business_id).toBe('0112038-9');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('businessId=0112038-9');
  });

  it('maps a provider rate limit response to a registry rate limit error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too many requests', { status: 429 })));
    const provider = createPrhYtjRegistryProvider(makeConfig());

    await expect(provider.searchByName({ query: 'Nokia' })).rejects.toMatchObject({
      code: ErrorCodes.registryRateLimited,
      statusCode: 429,
    });
  });

  it('maps provider HTTP failures to a temporary unavailable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const provider = createPrhYtjRegistryProvider(makeConfig());

    await expect(provider.getByBusinessId('0112038-9')).rejects.toMatchObject({
      code: ErrorCodes.registryUnavailable,
      statusCode: 503,
    });
  });

  it('maps network failures and timeouts to a temporary unavailable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const provider = createPrhYtjRegistryProvider(makeConfig());
    await expect(provider.searchByName({ query: 'Nokia' })).rejects.toMatchObject({
      code: ErrorCodes.registryUnavailable,
      statusCode: 503,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation timed out.', 'TimeoutError')),
            );
          }),
      ),
    );
    const slowProvider = createPrhYtjRegistryProvider(
      makeConfig({ BUSINESS_REGISTRY_TIMEOUT_MS: '250' }),
    );
    await expect(slowProvider.searchByName({ query: 'Nokia' })).rejects.toMatchObject({
      code: ErrorCodes.registryUnavailable,
      statusCode: 503,
    });
  });

  it('rejects malformed JSON and schema-invalid payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    const provider = createPrhYtjRegistryProvider(makeConfig());
    await expect(provider.searchByName({ query: 'Nokia' })).rejects.toMatchObject({
      code: ErrorCodes.registryUnavailable,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ totalResults: 1, companies: [{ unexpected: true }] })),
    );
    await expect(provider.searchByName({ query: 'Nokia' })).rejects.toMatchObject({
      code: ErrorCodes.registryUnavailable,
    });
  });
});
