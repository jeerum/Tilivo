import { describe, expect, it } from 'vitest';
import {
  allocatedTotal,
  reconciliationDifference,
  resolveSuggestion,
  suggestPurchaseMatches,
  suggestSalesMatches,
} from '../src/services/bankingMatching';

const invoice = (id: string, number: string, total: string, paid = '0', reference?: string) => ({
  id,
  invoice_number: number,
  customer_name: 'Acme Customer Oy',
  total,
  amount_paid: paid,
  credited_amount: '0',
  advance_applied: '0',
  payment_reference: reference ?? null,
});

describe('banking matching engine', () => {
  it('finds an exact reference sales match', () => {
    const matches = suggestSalesMatches(
      { direction: 'IN', reference: '12345672', amount: '400.00', message: 'Invoice' },
      [invoice('a', '2026-000001', '1000.00', '0', '12345672')],
    );
    expect(matches[0]!.confidence).toBe(1);
    expect(matches[0]!.source).toBe('EXACT');
  });

  it('finds amount+customer heuristic matches', () => {
    const matches = suggestSalesMatches(
      { direction: 'IN', amount: '400.00', message: 'Acme Customer Oy' },
      [invoice('a', '2026-000001', '400.00')],
    );
    expect(matches[0]!.confidence).toBe(0.9);
  });

  it('matches outgoing purchases by exact reference', () => {
    const matches = suggestPurchaseMatches(
      { direction: 'OUT', reference: '12345672', amount: '300.00' },
      [{ id: 'p1', invoice_number: 'S-1', supplier_name: 'Supplier Oy', total: '300.00', amount_paid: '0', payment_reference: '12345672' }],
    );
    expect(matches[0]!.confidence).toBe(1);
  });

  it('detects ambiguity when candidates are close', () => {
    const matches = [
      { targetType: 'SALES_INVOICE', targetId: 'a', number: '1', partyName: 'X', amount: '10.00', openAmount: '10.00', confidence: 0.8, reason: 'r', source: 'HEURISTIC' },
      { targetType: 'SALES_INVOICE', targetId: 'b', number: '2', partyName: 'Y', amount: '10.00', openAmount: '10.00', confidence: 0.75, reason: 'r', source: 'HEURISTIC' },
    ] as any;
    expect(resolveSuggestion(matches).ambiguous).toHaveLength(2);
  });

  it('computes allocation totals and differences', () => {
    expect(allocatedTotal([{ amount: '400.00' }, { amount: '600.00' }])).toBe('1000.00');
    expect(reconciliationDifference('1000.00', [{ amount: '400.00' }])).toBe('600.00');
    expect(reconciliationDifference('1000.00', [{ amount: '400.00' }, { amount: '600.00' }])).toBe('0.00');
  });
});
