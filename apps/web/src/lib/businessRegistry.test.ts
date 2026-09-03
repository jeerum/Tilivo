import { describe, expect, it } from 'vitest';
import {
  conflictingRegistryFields,
  registryFormPatch,
  registryPartyFields,
  type RegistryCompany,
} from './businessRegistry';

function company(): RegistryCompany {
  return {
    provider: 'PRH_YTJ_V3',
    business_id: '0112038-9',
    legal_name: 'Nokia Oyj',
    vat_id: 'FI01120389',
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
    fetched_at: '2026-09-03T08:00:00.000Z',
  };
}

describe('business registry frontend helpers', () => {
  it('builds a form patch from a normalized registry company', () => {
    const patch = registryFormPatch(company());
    expect(patch).toEqual({
      name: 'Nokia Oyj',
      business_id: '0112038-9',
      vat_id: 'FI01120389',
      address_line1: 'Karakaari 7',
      postal_code: '02610',
      city: 'Espoo',
      country_code: 'FI',
    });
  });

  it('builds the persisted registry metadata fields', () => {
    const fields = registryPartyFields(company());
    expect(fields.registry_source).toBe('PRH_YTJ_V3');
    expect(fields.registry_source_id).toBe('0112038-9');
    expect(fields.registry_snapshot?.legal_name).toBe('Nokia Oyj');
  });

  it('detects only fields where the user already entered a different value', () => {
    const incoming = registryFormPatch(company());
    expect(conflictingRegistryFields({ name: 'Nokia Oyj', city: '', business_id: '' }, incoming)).toEqual([]);
    expect(conflictingRegistryFields({ name: 'Different Oy', city: 'Tampere', business_id: '' }, incoming)).toEqual([
      'name',
      'city',
    ]);
  });
});
