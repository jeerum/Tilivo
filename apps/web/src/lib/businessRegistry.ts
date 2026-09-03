import { api } from '../auth/api';

export type RegistryCompanyStatus =
  | 'ACTIVE'
  | 'PENDING'
  | 'CEASED'
  | 'DEREGISTERED'
  | 'INVALIDATED'
  | 'BANKRUPT'
  | 'LIQUIDATION'
  | 'REORGANISATION'
  | 'UNKNOWN';

export interface RegistryRegisterState {
  registered: boolean;
  code: string | null;
}

export interface RegistryRegisters {
  trade: RegistryRegisterState;
  vat: RegistryRegisterState;
  prepayment: RegistryRegisterState;
  employer: RegistryRegisterState;
}

export interface RegistryAddress {
  street: string | null;
  postal_box: string | null;
  postal_code: string | null;
  city: string | null;
  country_code: string;
}

export interface RegistryCompanyForm {
  code: string;
  label_fi: string | null;
  label_en: string | null;
}

export interface RegistryCompany {
  provider: string;
  business_id: string;
  legal_name: string;
  vat_id: string | null;
  status: RegistryCompanyStatus;
  status_code: string | null;
  trade_register_status: string | null;
  registration_date: string | null;
  end_date: string | null;
  company_form: RegistryCompanyForm | null;
  address: RegistryAddress | null;
  registers: RegistryRegisters;
  fetched_at: string;
}

export interface RegistrySearchResponse {
  query: string;
  provider: string;
  searched_by: 'BUSINESS_ID' | 'NAME';
  results: RegistryCompany[];
  total: number;
  from_cache: boolean;
}

export interface RegistryRequestOptions {
  csrf: string;
  headers?: Record<string, string>;
  query: string;
  limit?: number;
}

export async function searchBusinessRegistry(
  options: RegistryRequestOptions,
): Promise<RegistrySearchResponse> {
  const params = new URLSearchParams({ q: options.query });
  if (options.limit) params.set('limit', String(options.limit));
  return api<RegistrySearchResponse>(`/api/v1/business-registry/search?${params.toString()}`, {
    headers: options.headers,
  });
}

/** Registry metadata persisted together with a customer/supplier save. */
export interface RegistryPartyFields {
  registry_source: string | null;
  registry_source_id: string | null;
  registry_fetched_at: string | null;
  registry_snapshot: RegistryCompany | null;
}

export function registryPartyFields(company: RegistryCompany): RegistryPartyFields {
  return {
    registry_source: company.provider,
    registry_source_id: company.business_id,
    registry_fetched_at: company.fetched_at,
    registry_snapshot: company,
  };
}

export interface RegistryFormPatch {
  name: string;
  business_id: string;
  vat_id: string;
  address_line1: string;
  postal_code: string;
  city: string;
  country_code: string;
}

/** Values a registry selection can safely fill into a party form. */
export function registryFormPatch(company: RegistryCompany): RegistryFormPatch {
  return {
    name: company.legal_name,
    business_id: company.business_id,
    vat_id: company.vat_id ?? '',
    address_line1: company.address?.street ?? company.address?.postal_box ?? '',
    postal_code: company.address?.postal_code ?? '',
    city: company.address?.city ?? '',
    country_code: company.address?.country_code || 'FI',
  };
}

/** Fields where the user already typed a different value than registry data. */
export function conflictingRegistryFields(
  current: Record<string, string>,
  incoming: RegistryFormPatch,
): Array<keyof RegistryFormPatch> {
  const conflicts: Array<keyof RegistryFormPatch> = [];
  for (const key of Object.keys(incoming) as Array<keyof RegistryFormPatch>) {
    const existing = String(current[key] ?? '').trim();
    const next = String(incoming[key]).trim();
    if (existing && existing !== next) conflicts.push(key);
  }
  return conflicts;
}
