import { normalizePaymentReference, normalizeReferenceForMatching } from '../lib/bankNormalization';

export interface MatchCandidate {
  targetType: 'SALES_INVOICE' | 'PURCHASE_INVOICE';
  targetId: string;
  number: string;
  partyName: string;
  amount: string;
  openAmount: string;
  confidence: number;
  reason: string;
  source: 'EXACT' | 'HEURISTIC';
}

interface SalesCandidateShape {
  id: string;
  invoice_number: string | null;
  customer_name?: string;
  customer_snapshot?: any;
  total: string | number;
  advance_applied?: string | number;
  credited_amount?: string | number;
  amount_paid?: string | number;
  payment_reference?: string | null;
}

interface PurchaseCandidateShape {
  id: string;
  invoice_number?: string | null;
  supplier_name?: string;
  total: string | number;
  amount_paid?: string | number;
  payment_reference?: string | null;
}

function openAmount(invoice: SalesCandidateShape | PurchaseCandidateShape, advanceApplied = 0): number {
  const total = Number(invoice.total);
  const paid = Number((invoice as any).amount_paid ?? 0);
  const credited = Number((invoice as any).credited_amount ?? 0);
  const remaining = total - advanceApplied - credited - paid;
  return remaining > 0 ? remaining : 0;
}

function referenceEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return normalizeReferenceForMatching(left) === normalizeReferenceForMatching(right);
}

function nameContains(name: string | null | undefined, message: string | null | undefined): boolean {
  if (!name || !message) return false;
  return message.toLowerCase().includes(String(name).trim().toLowerCase());
}

export function suggestSalesMatches(
  transaction: { direction: string; reference?: string | null; message?: string | null; amount: string; counterpartyName?: string | null; counterpartyIban?: string | null },
  invoices: SalesCandidateShape[],
): MatchCandidate[] {
  if (transaction.direction !== 'IN') return [];
  const amount = Number(transaction.amount);
  const message = `${transaction.message ?? ''} ${transaction.reference ?? ''}`;
  const candidates: MatchCandidate[] = [];
  for (const invoice of invoices) {
    const open = openAmount(invoice, Number(invoice.advance_applied ?? 0));
    if (open <= 0) continue;
    const partyName = invoice.customer_name ?? String(invoice.customer_snapshot?.name ?? '');
    let confidence = 0;
    let reason = '';
    let source: 'EXACT' | 'HEURISTIC' = 'HEURISTIC';
    const number = String(invoice.invoice_number ?? '');
    if (referenceEquals(transaction.reference, invoice.payment_reference)) {
      confidence = 1;
      reason = 'Exact payment reference';
      source = 'EXACT';
    } else if (number && message.includes(number)) {
      confidence = open === amount ? 0.98 : 0.8;
      reason = 'Invoice number in message' + (open === amount ? ' with exact amount' : '');
    } else if (open === amount && (nameContains(partyName, transaction.message) || transaction.counterpartyName?.toLowerCase() === partyName.toLowerCase())) {
      confidence = 0.9;
      reason = 'Exact amount and customer name';
    } else if (open === amount) {
      confidence = 0.8;
      reason = 'Exact open amount';
    } else if (transaction.counterpartyName?.toLowerCase() === partyName.toLowerCase()) {
      confidence = 0.6;
      reason = 'Customer name';
    }
    if (confidence > 0) {
      candidates.push({
        targetType: 'SALES_INVOICE',
        targetId: invoice.id,
        number,
        partyName,
        amount: amount.toFixed(2),
        openAmount: open.toFixed(2),
        confidence,
        reason,
        source,
      });
    }
  }
  candidates.sort((left, right) => right.confidence - left.confidence);
  return candidates;
}

export function suggestPurchaseMatches(
  transaction: { direction: string; reference?: string | null; message?: string | null; amount: string; counterpartyName?: string | null },
  invoices: PurchaseCandidateShape[],
): MatchCandidate[] {
  if (transaction.direction !== 'OUT') return [];
  const amount = Number(transaction.amount);
  const message = `${transaction.message ?? ''} ${transaction.reference ?? ''}`;
  const candidates: MatchCandidate[] = [];
  for (const invoice of invoices) {
    const open = openAmount(invoice);
    if (open <= 0) continue;
    let confidence = 0;
    let reason = '';
    let source: 'EXACT' | 'HEURISTIC' = 'HEURISTIC';
    const number = String(invoice.invoice_number ?? '');
    if (referenceEquals(transaction.reference, invoice.payment_reference)) {
      confidence = 1;
      reason = 'Exact payment reference';
      source = 'EXACT';
    } else if (number && message.includes(number)) {
      confidence = open === amount ? 0.98 : 0.8;
      reason = 'Invoice number in message' + (open === amount ? ' with exact amount' : '');
    } else if (open === amount) {
      confidence = 0.85;
      reason = 'Exact open amount';
    }
    if (confidence > 0) {
      candidates.push({
        targetType: 'PURCHASE_INVOICE',
        targetId: invoice.id,
        number,
        partyName: invoice.supplier_name ?? '',
        amount: amount.toFixed(2),
        openAmount: open.toFixed(2),
        confidence,
        reason,
        source,
      });
    }
  }
  candidates.sort((left, right) => right.confidence - left.confidence);
  return candidates;
}

export function resolveSuggestion(candidates: MatchCandidate[]): { suggestion?: MatchCandidate; ambiguous: MatchCandidate[] } {
  if (candidates.length === 0) return { ambiguous: [] };
  const top = candidates[0]!;
  const close = candidates.filter((candidate) => top.confidence - candidate.confidence < 0.15);
  if (close.length > 1 && top.confidence < 1) return { ambiguous: close };
  return { suggestion: top, ambiguous: [] };
}

export function allocatedTotal(allocations: Array<{ amount: string | number }>): string {
  return allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0).toFixed(2);
}

export function reconciliationDifference(transactionAmount: string, allocations: Array<{ amount: string | number }>): string {
  const difference = Math.abs(Number(transactionAmount)) - Number(allocatedTotal(allocations));
  return Math.abs(difference) < 0.001 ? '0.00' : difference.toFixed(2);
}

export { normalizePaymentReference };
