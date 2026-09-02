import { describe, expect, it } from 'vitest';
import { pdfSha256, renderInvoicePdf } from '../src/services/invoicePdf';

const fixture = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  invoice_number: '2026-000001',
  status: 'ISSUED',
  issue_date: '2026-09-02',
  due_date: '2026-09-16',
  currency_code: 'EUR',
  payment_reference: '20260000013',
  subtotal: '1000.00',
  tax_total: '240.00',
  total: '1240.00',
  seller_legal_name: 'Tilivo QA Tenant Oy',
  seller_business_id: 'FI12345678',
  customer_snapshot: {
    name: 'Acme Customer Oy',
    business_id: 'FI87654321',
    vat_id: 'FI87654321',
    address_line1: 'Testikatu 1',
    postal_code: '00100',
    city: 'Helsinki',
    country_code: 'FI',
    language: 'fi',
  },
  lines: [
    {
      description: 'Consulting services September',
      quantity: '2',
      unit: 'h',
      unit_price: '500.00',
      net_amount: '1000.00',
      tax_rate_snapshot: '24.0000',
      tax_amount: '240.00',
      gross_amount: '1240.00',
    },
  ],
};

describe('invoice PDF renderer', () => {
  it('produces a deterministic, structurally valid PDF', () => {
    const first = renderInvoicePdf(fixture as any);
    const second = renderInvoicePdf(fixture as any);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.subarray(first.length - 6, first.length).toString('latin1').trim()).toBe('%%EOF');

    const text = first.toString('latin1');
    const startXref = Number(text.match(/startxref\n(\d+)/)?.[1]);
    const xrefSection = text.slice(startXref);
    expect(xrefSection.startsWith('xref')).toBe(true);
    const trailer = xrefSection.match(/trailer\n/);
    expect(trailer).not.toBeNull();

    // Every declared xref offset must point at an object start.
    const offsets = [...text.slice(startXref).matchAll(/^(\d{10}) 00000 n/gm)].map((match) => Number(match[1]));
    for (const offset of offsets) {
      expect(/^\d+ 0 obj/.test(text.slice(offset, offset + 24))).toBe(true);
    }
    expect(pdfSha256(first)).toBe(pdfSha256(second));
    expect(pdfSha256(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps credit notes distinct from invoices', () => {
    const credit = renderInvoicePdf({ ...(fixture as any), credit_of_invoice_id: fixture.id, invoice_number: '2026-000002' });
    expect(credit.toString('latin1')).toContain('CREDIT NOTE 2026-000002');
    const invoice = renderInvoicePdf(fixture as any);
    expect(invoice.equals(credit)).toBe(false);
  });
});
