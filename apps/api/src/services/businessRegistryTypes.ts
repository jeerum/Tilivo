import { z } from 'zod';

export const REGISTRY_PROVIDER_PRH_YTJ_V3 = 'PRH_YTJ_V3';

export const registryStatusValues = [
  'ACTIVE',
  'PENDING',
  'CEASED',
  'DEREGISTERED',
  'INVALIDATED',
  'BANKRUPT',
  'LIQUIDATION',
  'REORGANISATION',
  'UNKNOWN',
] as const;

export type RegistryCompanyStatus = (typeof registryStatusValues)[number];

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

/**
 * Normalized, provider-independent registry company. Provider-specific raw
 * codes are preserved in dedicated fields (status_code,
 * trade_register_status, register codes) so an audit trail can always point
 * back to source data without shipping large raw payloads to the UI.
 */
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

const nullableShort = (max: number) => z.string().trim().max(max).nullable();
const nullableText = (max: number) => z.string().trim().max(max).nullable();

const registerStateSchema = z.object({
  registered: z.boolean(),
  code: nullableShort(32),
});

const registersSchema = z.object({
  trade: registerStateSchema,
  vat: registerStateSchema,
  prepayment: registerStateSchema,
  employer: registerStateSchema,
});

const addressSchema = z.object({
  street: nullableText(500),
  postal_box: nullableText(500),
  postal_code: nullableText(32),
  city: nullableText(120),
  country_code: z.string().trim().length(2),
});

const companyFormSchema = z.object({
  code: z.string().trim().min(1).max(32),
  label_fi: nullableText(255),
  label_en: nullableText(255),
});

/**
 * Shape of a normalized registry company. The same schema validates both the
 * search API response items and the `registry_snapshot` accepted when a
 * customer/supplier is saved with registry data, so only server-validated
 * registry objects are persisted.
 */
export const registryCompanySchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    business_id: z.string().regex(/^\d{7}-\d$/, 'Invalid Business ID'),
    legal_name: z.string().trim().min(1).max(1000),
    vat_id: nullableShort(64),
    status: z.enum(registryStatusValues),
    status_code: nullableShort(16),
    trade_register_status: nullableShort(16),
    registration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    company_form: companyFormSchema.nullable(),
    address: addressSchema.nullable(),
    registers: registersSchema,
    fetched_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type RegistryCompanySnapshot = z.infer<typeof registryCompanySchema>;

export function defaultRegisters(): RegistryRegisters {
  return {
    trade: { registered: false, code: null },
    vat: { registered: false, code: null },
    prepayment: { registered: false, code: null },
    employer: { registered: false, code: null },
  };
}
