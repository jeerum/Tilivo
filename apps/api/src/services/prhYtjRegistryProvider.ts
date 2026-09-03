import { z } from 'zod';
import type { AppConfig } from '../config/env';
import { AppError, ErrorCodes } from '../lib/errors';
import { formatFinnishVatId, normalizeFinnishBusinessId } from '../lib/businessId';
import {
  REGISTRY_PROVIDER_PRH_YTJ_V3,
  defaultRegisters,
  type RegistryAddress,
  type RegistryCompany,
  type RegistryCompanyStatus,
  type RegistryRegisters,
} from './businessRegistryTypes';
import type { BusinessRegistryProvider } from './businessRegistryProvider';

const nullableRawString = z.preprocess(
  (value) => (value === undefined || value === null ? null : String(value)),
  z.string().nullable(),
);

const descriptionRawSchema = z
  .object({
    languageCode: z.string(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const nameRawSchema = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    registrationDate: nullableRawString.optional(),
    endDate: nullableRawString.optional(),
    version: z.number().int().optional(),
  })
  .passthrough();

const companyFormRawSchema = z
  .object({
    type: z.string().optional(),
    descriptions: z.array(descriptionRawSchema).default([]),
    endDate: nullableRawString.optional(),
    version: z.number().int().optional(),
  })
  .passthrough();

const situationRawSchema = z
  .object({
    type: z.string(),
    endDate: nullableRawString.optional(),
  })
  .passthrough();

const entryRawSchema = z
  .object({
    type: z.string(),
    register: z.string(),
    endDate: nullableRawString.optional(),
  })
  .passthrough();

const postOfficeRawSchema = z
  .object({
    city: z.string(),
    languageCode: z.string(),
  })
  .passthrough();

const addressRawSchema = z
  .object({
    type: z.number().int(),
    street: nullableRawString.optional(),
    postCode: nullableRawString.optional(),
    postOffices: z.array(postOfficeRawSchema).default([]),
    postOfficeBox: nullableRawString.optional(),
    buildingNumber: nullableRawString.optional(),
    country: nullableRawString.optional(),
    freeAddressLine: nullableRawString.optional(),
  })
  .passthrough();

const businessIdRawSchema = z
  .object({
    value: z.string(),
    registrationDate: nullableRawString.optional(),
  })
  .passthrough();

const companyRawSchema = z
  .object({
    businessId: businessIdRawSchema,
    names: z.array(nameRawSchema).default([]),
    companyForms: z.array(companyFormRawSchema).default([]),
    companySituations: z.array(situationRawSchema).default([]),
    registeredEntries: z.array(entryRawSchema).default([]),
    addresses: z.array(addressRawSchema).default([]),
    tradeRegisterStatus: nullableRawString.optional(),
    status: nullableRawString.optional(),
    registrationDate: nullableRawString.optional(),
    endDate: nullableRawString.optional(),
    lastModified: nullableRawString.optional(),
  })
  .passthrough();

const companyResultSchema = z.object({
  totalResults: z.number().int().optional(),
  companies: z.array(companyRawSchema).default([]),
});

type RawCompany = z.infer<typeof companyRawSchema>;
type RawName = z.infer<typeof nameRawSchema>;
type RawAddress = z.infer<typeof addressRawSchema>;

interface RegistryProviderConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function createPrhYtjRegistryProvider(config: AppConfig): BusinessRegistryProvider {
  const providerConfig: RegistryProviderConfig = {
    baseUrl: config.BUSINESS_REGISTRY_BASE_URL.replace(/\/+$/, ''),
    timeoutMs: config.BUSINESS_REGISTRY_TIMEOUT_MS,
  };
  return {
    name: REGISTRY_PROVIDER_PRH_YTJ_V3,
    searchByName: ({ query, limit }) => searchByName(providerConfig, query, limit),
    getByBusinessId: (businessId) => getByBusinessId(providerConfig, businessId),
  };
}

async function searchByName(
  config: RegistryProviderConfig,
  query: string,
  limit = 20,
): Promise<RegistryCompany[]> {
  const url = `${config.baseUrl}/companies?name=${encodeURIComponent(query)}&page=1`;
  const payload = await requestJson<{ companies: RawCompany[] }>(config, url);
  const companies = (payload.companies ?? []).map(mapRawCompany).filter(isPresent);
  return companies.slice(0, Math.min(Math.max(limit, 1), 100));
}

async function getByBusinessId(
  config: RegistryProviderConfig,
  businessId: string,
): Promise<RegistryCompany | null> {
  const canonical = normalizeFinnishBusinessId(businessId);
  if (!canonical) return null;
  const url = `${config.baseUrl}/companies?businessId=${encodeURIComponent(canonical)}`;
  const payload = await requestJson<{ companies: RawCompany[] }>(config, url);
  const company = payload.companies?.[0];
  if (!company) return null;
  const mapped = mapRawCompany(company);
  return isPresent(mapped) ? mapped : null;
}

function isPresent(company: RegistryCompany | null): company is RegistryCompany {
  return company !== null;
}

async function requestJson<T>(config: RegistryProviderConfig, url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (cause.name === 'AbortError' || cause.name === 'TimeoutError') {
      throw new AppError(
        ErrorCodes.registryUnavailable,
        'Registry service is temporarily unavailable',
        503,
        { stage: 'timeout' },
      );
    }
    throw new AppError(ErrorCodes.registryUnavailable, 'Registry service is temporarily unavailable', 503, {
      stage: 'network',
    });
  }

  if (response.status === 429) {
    throw new AppError(ErrorCodes.registryRateLimited, 'Too many searches. Please wait a moment.', 429);
  }
  if (!response.ok) {
    throw new AppError(ErrorCodes.registryUnavailable, 'Registry service is temporarily unavailable', 503, {
      stage: 'http',
      status: response.status,
    });
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(ErrorCodes.registryUnavailable, 'Registry service is temporarily unavailable', 503, {
      stage: 'malformed_json',
    });
  }
  const result = companyResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(ErrorCodes.registryUnavailable, 'Registry service is temporarily unavailable', 503, {
      stage: 'schema',
      issues: result.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data as unknown as T;
}

function mapRawCompany(raw: RawCompany): RegistryCompany | null {
  const businessId = normalizeFinnishBusinessId(raw.businessId.value);
  if (!businessId) return null;
  const legalName = pickCurrentName(raw.names);
  if (!legalName) return null;

  const statusInfo = deriveStatus(raw);
  const vatId = formatFinnishVatId(businessId);
  return {
    provider: REGISTRY_PROVIDER_PRH_YTJ_V3,
    business_id: businessId,
    legal_name: legalName,
    vat_id: vatId,
    status: statusInfo.status,
    status_code: statusInfo.statusCode,
    trade_register_status: raw.tradeRegisterStatus ?? null,
    registration_date: raw.registrationDate ?? raw.businessId.registrationDate ?? null,
    end_date: statusInfo.endDate,
    company_form: extractCompanyForm(raw.companyForms),
    address: extractAddress(raw.addresses),
    registers: extractRegisters(raw.registeredEntries),
    fetched_at: new Date().toISOString(),
  };
}

function pickCurrentName(names: RawName[]): string | null {
  const valid = names.filter((entry) => String(entry.name ?? '').trim());
  const byVersion = (a: RawName, b: RawName) => (a.version ?? 99) - (b.version ?? 99);
  const current =
    [...valid].filter((entry) => entry.type === '1' && !entry.endDate).sort(byVersion)[0] ??
    [...valid].filter((entry) => entry.type === '1').sort(byVersion)[0] ??
    [...valid].filter((entry) => !entry.endDate).sort(byVersion)[0] ??
    valid[0];
  return current ? String(current.name).trim() || null : null;
}

function extractCompanyForm(
  forms: Array<{ type?: string; descriptions?: Array<{ languageCode: string; description?: string | null }>; endDate?: string | null }>,
): RegistryCompany['company_form'] {
  const current =
    [...forms].filter((form) => !form.endDate).sort((a, b) => (a.type ? 0 : 1) - (b.type ? 0 : 1))[0] ??
    forms[0];
  if (!current?.type) return null;
  const descriptions = current.descriptions ?? [];
  return {
    code: current.type,
    label_fi: descriptionFor(descriptions, '1') ?? null,
    label_en: descriptionFor(descriptions, '3') ?? null,
  };
}

function descriptionFor(
  descriptions: Array<{ languageCode: string; description?: string | null }>,
  languageCode: string,
): string | undefined {
  return descriptions.find((entry) => entry.languageCode === languageCode)?.description ?? undefined;
}

function extractAddress(addresses: RawAddress[]): RegistryAddress | null {
  const street = addresses.find((entry) => entry.type === 1) ?? addresses[0];
  if (!street) return null;
  const cityEntry =
    [...(street.postOffices ?? [])].sort(
      (a, b) => languagePriority(a.languageCode) - languagePriority(b.languageCode),
    )[0] ?? null;

  const streetParts = [String(street.street ?? ''), String(street.buildingNumber ?? '')]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
  const postalBox = street.postOfficeBox ? `PL ${String(street.postOfficeBox).trim()}` : null;
  return {
    street: streetParts || null,
    postal_box: postalBox,
    postal_code: street.postCode ? String(street.postCode).trim() || null : null,
    city: cityEntry ? String(cityEntry.city).trim() || null : null,
    country_code: street.country && String(street.country).trim().length === 2 ? String(street.country).toUpperCase() : 'FI',
  };
}

function languagePriority(languageCode: string): number {
  if (languageCode === '1') return 0;
  if (languageCode === '3') return 1;
  if (languageCode === '2') return 2;
  return 3;
}

const VAT_ACTIVE_TYPES = new Set(['80', '82', '83', '84', '85', '86', '87', '88', 'V80']);
const PREPAYMENT_ACTIVE_TYPES = new Set(['55']);
const EMPLOYER_ACTIVE_TYPES = new Set(['41', '42']);

function extractRegisters(
  entries: Array<{ type: string; register: string; endDate?: string | null }>,
): RegistryRegisters {
  const registers = defaultRegisters();
  registers.trade = stateFor(entries, '1', (type) => type === '1');
  registers.vat = stateFor(entries, '6', (type) => VAT_ACTIVE_TYPES.has(type));
  registers.prepayment = stateFor(entries, '5', (type) => PREPAYMENT_ACTIVE_TYPES.has(type));
  registers.employer = stateFor(entries, '7', (type) => EMPLOYER_ACTIVE_TYPES.has(type));
  return registers;
}

function stateFor(
  entries: Array<{ type: string; register: string; endDate?: string | null }>,
  registerCode: string,
  active: (type: string) => boolean,
): RegistryRegisters['trade'] {
  const matching = entries.filter((entry) => entry.register === registerCode);
  const activeEntry = matching.find((entry) => !entry.endDate && active(entry.type));
  const representative = activeEntry ?? matching[0];
  return {
    registered: Boolean(activeEntry),
    code: representative ? `${representative.register}_${representative.type}` : null,
  };
}

function deriveStatus(raw: RawCompany): {
  status: RegistryCompanyStatus;
  statusCode: string | null;
  endDate: string | null;
} {
  const statusCode = raw.status ?? null;
  const endDate = raw.endDate ?? null;
  const openSituation = (raw.companySituations ?? []).find((situation) => !situation.endDate);

  if (openSituation) {
    if (openSituation.type === 'KONK') return { status: 'BANKRUPT', statusCode, endDate };
    if (openSituation.type === 'SELTILA') return { status: 'LIQUIDATION', statusCode, endDate };
    if (openSituation.type === 'SANE') return { status: 'REORGANISATION', statusCode, endDate };
  }
  if (endDate) return { status: 'CEASED', statusCode, endDate };
  if (statusCode === '5') return { status: 'INVALIDATED', statusCode, endDate };

  const tradeStatus = raw.tradeRegisterStatus ?? null;
  if (tradeStatus === '4') return { status: 'CEASED', statusCode, endDate };
  if (tradeStatus === '2') return { status: 'DEREGISTERED', statusCode, endDate };
  if (statusCode === '1' || tradeStatus === '3' || tradeStatus === '0') {
    return { status: 'PENDING', statusCode, endDate };
  }
  if (statusCode === '2' || tradeStatus === '1') return { status: 'ACTIVE', statusCode, endDate };
  return { status: 'UNKNOWN', statusCode, endDate };
}
