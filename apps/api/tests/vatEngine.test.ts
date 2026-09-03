import { describe, expect, it } from 'vitest';
import {
  calculateVat,
  classifyTreatment,
  fillLegalNote,
  isTaxDirectionAllowed,
  legalNoteForLanguage,
  TAX_TREATMENTS,
  VAT_CLASSIFICATIONS,
  VAT_DIRECTIONS,
} from '../src/services/vatEngineService';

describe('v0.9 VAT engine', () => {
  it('calculates standard domestic sales VAT and posts output VAT', () => {
    const calc = calculateVat({
      direction: 'SALES',
      treatment: TAX_TREATMENTS.STANDARD,
      rate: '25.5',
      netAmount: '100.00',
    });
    expect(calc.taxableBase).toBe('100.00');
    expect(calc.invoiceTaxAmount).toBe('25.50');
    expect(calc.grossAmount).toBe('125.50');
    expect(calc.classification).toBe(VAT_CLASSIFICATIONS.DOMESTIC_OUTPUT_VAT);
    expect(calc.legs).toEqual([{ legType: 'OUTPUT_VAT', amount: '25.50' }]);
  });

  it('calculates domestic purchase input VAT', () => {
    const calc = calculateVat({
      direction: 'PURCHASE',
      treatment: TAX_TREATMENTS.STANDARD,
      rate: '25.5',
      netAmount: '100.00',
    });
    expect(calc.invoiceTaxAmount).toBe('25.50');
    expect(calc.grossAmount).toBe('125.50');
    expect(calc.classification).toBe(VAT_CLASSIFICATIONS.DOMESTIC_INPUT_VAT);
    expect(calc.legs).toEqual([{ legType: 'INPUT_VAT', amount: '25.50' }]);
  });

  it('applies reduced and 10 percent rates as domestic VAT', () => {
    const reduced = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.REDUCED, rate: '13.5', netAmount: '100',
    });
    const ten = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.REDUCED, rate: '10', netAmount: '100',
    });
    expect(reduced.invoiceTaxAmount).toBe('13.50');
    expect(ten.invoiceTaxAmount).toBe('10.00');
    expect(reduced.classification).toBe(VAT_CLASSIFICATIONS.DOMESTIC_OUTPUT_VAT);
    expect(ten.classification).toBe(VAT_CLASSIFICATIONS.DOMESTIC_INPUT_VAT);
  });

  it('keeps zero-rated, exempt and reverse charge distinct treatments', () => {
    const zero = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.ZERO_RATED, rate: '0', netAmount: '50',
    });
    const exempt = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.EXEMPT, rate: '0', netAmount: '50',
    });
    const rcSale = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.REVERSE_CHARGE, rate: '25.5', netAmount: '50',
    });
    expect(zero.invoiceTaxAmount).toBe('0.00');
    expect(exempt.invoiceTaxAmount).toBe('0.00');
    expect(rcSale.invoiceTaxAmount).toBe('0.00');
    expect(rcSale.reportableTaxAmount).toBe('0.00');
    expect(zero.legs).toEqual([]);
    expect(exempt.legs).toEqual([]);
    expect(zero.classification).toBe(VAT_CLASSIFICATIONS.ZERO_RATED);
    expect(exempt.classification).toBe(VAT_CLASSIFICATIONS.EXEMPT);
  });

  it('self-assesses EU goods acquisitions with output and input legs', () => {
    const calc = calculateVat({
      direction: 'PURCHASE',
      treatment: TAX_TREATMENTS.EU_GOODS_ACQUISITION,
      rate: '25.5',
      netAmount: '1000.00',
    });
    expect(calc.invoiceTaxAmount).toBe('0.00');
    expect(calc.selfAssessedTaxAmount).toBe('255.00');
    expect(calc.payableAmount).toBe('1000.00');
    expect(calc.classification).toBe(VAT_CLASSIFICATIONS.EU_GOODS_ACQUISITION);
    expect(calc.legs).toEqual([
      { legType: 'RC_OUTPUT_VAT', amount: '255.00' },
      { legType: 'RC_INPUT_VAT', amount: '255.00' },
    ]);
  });

  it('separates EU services from EU goods on both sides', () => {
    const sale = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.EU_SERVICE_SUPPLY, rate: '0', netAmount: '200',
    });
    const purchase = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.EU_SERVICE_ACQUISITION, rate: '25.5', netAmount: '200',
    });
    expect(sale.classification).toBe(VAT_CLASSIFICATIONS.EU_SERVICES_SUPPLY);
    expect(purchase.classification).toBe(VAT_CLASSIFICATIONS.EU_SERVICES_ACQUISITION);
    expect(purchase.selfAssessedTaxAmount).toBe('51.00');
  });

  it('handles export outside the EU without VAT legs', () => {
    const calc = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.EXPORT, rate: '0', netAmount: '800',
    });
    expect(calc.classification).toBe(VAT_CLASSIFICATIONS.EXPORT);
    expect(calc.grossAmount).toBe('800.00');
    expect(calc.legs).toEqual([]);
  });

  it('supports full, zero and partial purchase deductibility', () => {
    const full = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '100', deductiblePercent: '100',
    });
    const none = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '100', deductiblePercent: '0',
    });
    const half = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '100', deductiblePercent: '50',
    });
    expect(full.deductibleTax).toBe('25.50');
    expect(full.nonDeductibleTax).toBe('0.00');
    expect(none.deductibleTax).toBe('0.00');
    expect(none.nonDeductibleTax).toBe('25.50');
    expect(half.deductibleTax).toBe('12.75');
    expect(half.nonDeductibleTax).toBe('12.75');
    expect(half.expenseAmount).toBe('112.75');
    expect(half.payableAmount).toBe('125.50');
    expect(none.legs).toEqual([]);
  });

  it('rounds deterministically and handles awkward values', () => {
    const penny = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '0.01',
    });
    const awkward = calculateVat({
      direction: 'SALES', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '33.33',
    });
    const partial = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '33.33', deductiblePercent: '50',
    });
    expect(penny.invoiceTaxAmount).toBe('0.00');
    expect(awkward.invoiceTaxAmount).toBe('8.50');
    expect(partial.deductibleTax).toBe('4.25');
    expect(partial.nonDeductibleTax).toBe('4.25');
  });

  it('supports construction reverse-charge sales wording', () => {
    const calc = calculateVat({
      direction: 'SALES',
      treatment: TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE,
      rate: '0',
      netAmount: '1000',
      legalNotes: {
        fi: 'Lasku ei sisällä arvonlisäveroa (AVL 8 c §). Ostajan Y-tunnus: {buyer_id}',
        en: 'No VAT on this invoice (Section 8 c AVL). Buyer Business ID: {buyer_id}',
      },
      language: 'fi',
    });
    expect(calc.invoiceTaxAmount).toBe('0.00');
    expect(calc.legs).toEqual([]);
    expect(calc.legalNote).toContain('8 c');
    const filled = fillLegalNote(calc.legalNote, { businessId: 'FI12345678', vatId: 'FI12345678' });
    expect(filled).toContain('FI12345678');
  });

  it('keeps exempt purchases non-deductible', () => {
    const calc = calculateVat({
      direction: 'PURCHASE', treatment: TAX_TREATMENTS.EXEMPT, rate: '0', netAmount: '100', deductiblePercent: '100',
    });
    expect(calc.deductibleTax).toBe('0.00');
    expect(calc.expenseAmount).toBe('100.00');
  });

  it('classifies treatments and directions consistently', () => {
    expect(isTaxDirectionAllowed(VAT_DIRECTIONS.BOTH, 'SALES')).toBe(true);
    expect(isTaxDirectionAllowed(VAT_DIRECTIONS.PURCHASE, 'SALES')).toBe(false);
    expect(classifyTreatment(TAX_TREATMENTS.IMPORT, 'PURCHASE')).toBe(VAT_CLASSIFICATIONS.IMPORT);
    expect(classifyTreatment(TAX_TREATMENTS.CONSTRUCTION_REVERSE_CHARGE, 'SALES')).toBe(
      VAT_CLASSIFICATIONS.CONSTRUCTION_RC,
    );
  });

  it('falls back through legal note languages', () => {
    const notes = { fi: 'Suomi', en: 'English', et: 'Eesti' };
    expect(legalNoteForLanguage(notes, 'fi')).toBe('Suomi');
    expect(legalNoteForLanguage(notes, 'de')).toBe('Suomi');
    expect(legalNoteForLanguage({ et: 'Eesti' }, 'de')).toBe('Eesti');
  });
});
