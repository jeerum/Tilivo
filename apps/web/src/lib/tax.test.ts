import { describe, expect, it } from 'vitest';
import {
  deductibleTaxCents,
  invoiceTaxCents,
  lineNetCents,
  selfAssessedTaxCents,
  taxRateLabel,
  type TaxCodeView,
} from './tax';

function code(overrides: Partial<TaxCodeView> = {}): TaxCodeView {
  return {
    id: 'code-1',
    code: 'FI_SALES_STD',
    name: 'Standard',
    rate: '25.5',
    type: 'VAT',
    direction: 'BOTH',
    treatment: 'STANDARD',
    effective_from: '2024-09-01',
    effective_to: null,
    is_active: true,
    is_system: true,
    deductible_percent: '100',
    ...overrides,
  };
}

describe('web VAT preview helpers', () => {
  it('rounds net to cents', () => {
    expect(lineNetCents({ quantity: '3', unitPrice: '19.99' })).toBe(5997);
    expect(lineNetCents({ quantity: '1', unitPrice: '10', discountPercent: '10' })).toBe(900);
  });

  it('adds invoice VAT only for domestic taxable treatments', () => {
    expect(invoiceTaxCents(10000, code())).toBe(2550);
    expect(invoiceTaxCents(10000, code({ treatment: 'REDUCED', rate: '13.5' }))).toBe(1350);
    expect(invoiceTaxCents(10000, code({ treatment: 'ZERO_RATED', rate: '0' }))).toBe(0);
    expect(invoiceTaxCents(10000, code({ treatment: 'CONSTRUCTION_REVERSE_CHARGE', rate: '0' }))).toBe(0);
  });

  it('separates self-assessed purchase VAT and deductibility', () => {
    const rc = code({ direction: 'PURCHASE', code: 'FI_RC_PURCHASE', rate: '25.5', treatment: 'REVERSE_CHARGE' });
    expect(invoiceTaxCents(10000, rc)).toBe(0);
    expect(selfAssessedTaxCents(10000, rc)).toBe(2550);
    expect(deductibleTaxCents(10000, rc, '50')).toBe(1275);
  });

  it('renders rate labels semantically', () => {
    expect(taxRateLabel(code())).toBe('25.50%');
    expect(taxRateLabel(code({ treatment: 'EXEMPT', rate: '0' }))).toBe('0%');
    expect(taxRateLabel(code({ treatment: 'EU_GOODS_SUPPLY', rate: '0' }))).toBe('0%');
  });
});
