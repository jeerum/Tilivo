import { describe, expect, it } from 'vitest';
import { MockDocumentOcrProvider } from '../src/services/ocrService';
import { resolvePurchaseCounterAccount } from '../src/services/purchaseService';
import { calculateVat, TAX_TREATMENTS } from '../src/services/vatEngineService';

const settings = {
  accounts_payable_account_id: 'ap-1',
  cash_account_id: 'cash-1',
  company_card_account_id: 'card-1',
  employee_payable_account_id: 'employee-1',
};

describe('v0.10 purchase receipts unit', () => {
  it('selects Accounts Payable for unpaid bank-transfer purchases', () => {
    const result = resolvePurchaseCounterAccount('BANK_TRANSFER', 'UNPAID', settings);
    expect(result).toMatchObject({ kind: 'AP', accountId: 'ap-1', paidAtPurchase: false });
  });

  it('maps cash receipts to the cash account', () => {
    expect(resolvePurchaseCounterAccount('CASH', 'PAID_AT_PURCHASE', settings)).toMatchObject({
      kind: 'CASH',
      accountId: 'cash-1',
      paidAtPurchase: true,
    });
  });

  it('maps company-card receipts to the card clearing account', () => {
    expect(resolvePurchaseCounterAccount('COMPANY_CARD', 'PAID_AT_PURCHASE', settings)).toMatchObject({
      kind: 'COMPANY_CARD',
      accountId: 'card-1',
      paidAtPurchase: true,
    });
  });

  it('maps personal-card and employee-paid receipts to the employee payable', () => {
    expect(resolvePurchaseCounterAccount('PERSONAL_CARD', 'PAID_AT_PURCHASE', settings)).toMatchObject({
      kind: 'EMPLOYEE_PAYABLE',
      accountId: 'employee-1',
    });
    expect(resolvePurchaseCounterAccount('EMPLOYEE_PAID', 'PAID_AT_PURCHASE', settings)).toMatchObject({
      kind: 'EMPLOYEE_PAYABLE',
      accountId: 'employee-1',
    });
  });

  it('falls back to AP for OTHER payments and reports missing mappings as null', () => {
    expect(resolvePurchaseCounterAccount('OTHER', 'PAID_AT_PURCHASE', settings).kind).toBe('AP');
    expect(resolvePurchaseCounterAccount('CASH', 'PAID_AT_PURCHASE', {})).toMatchObject({
      kind: 'CASH',
      accountId: null,
    });
  });

  it('mock OCR normalizes receipt, invoice, multi-rate and low-confidence fixtures', async () => {
    const provider = new MockDocumentOcrProvider();
    const receipt = await provider.extract({ originalFilename: 'receipt-fi.jpg', mimeType: 'image/jpeg', data: Buffer.from('x') });
    expect(receipt.supplierName).toBe('Mock Merchant Oy');
    expect(receipt.total).toBe('125.50');
    expect(receipt.paymentMethod).toBe('CASH');
    expect(receipt.confidence.supplier_name).toBeGreaterThan(0.9);

    const invoice = await provider.extract({ originalFilename: 'purchase-invoice.pdf', mimeType: 'application/pdf', data: Buffer.from('x') });
    expect(invoice.documentNumber).toBe('INV-2026-1');

    const multi = await provider.extract({ originalFilename: 'multi-receipt.png', mimeType: 'image/png', data: Buffer.from('x') });
    expect(multi.lines).toHaveLength(2);
    expect(multi.vatTotal).toBe('19.50');

    const low = await provider.extract({ originalFilename: 'lowconf-receipt.jpg', mimeType: 'image/jpeg', data: Buffer.from('x') });
    expect(low.confidence.supplier_name).toBeLessThan(0.5);
  });

  it('mock OCR raises for malformed provider responses', async () => {
    const provider = new MockDocumentOcrProvider();
    await expect(
      provider.extract({ originalFilename: 'malformed-receipt.jpg', mimeType: 'image/jpeg', data: Buffer.from('x') }),
    ).rejects.toThrow('Malformed');
  });

  it('supports multi-rate VAT totals through the central engine', () => {
    const standard = calculateVat({ direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '50.00' });
    const reduced = calculateVat({ direction: 'PURCHASE', treatment: TAX_TREATMENTS.REDUCED, rate: '13.5', netAmount: '50.00' });
    const vat = Number(standard.reportableTaxAmount) + Number(reduced.reportableTaxAmount);
    expect(vat).toBe(19.5);
  });

  it('partial deductibility splits VAT deterministically', () => {
    const calc = calculateVat({ direction: 'PURCHASE', treatment: TAX_TREATMENTS.STANDARD, rate: '25.5', netAmount: '100.00', deductiblePercent: '50' });
    expect(calc.deductibleTax).toBe('12.75');
    expect(calc.nonDeductibleTax).toBe('12.75');
    expect(calc.expenseAmount).toBe('112.75');
  });
});
