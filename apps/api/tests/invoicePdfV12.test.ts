import { describe, expect, it } from 'vitest';
import { renderInvoicePdf, renderReminderPdf } from '../src/services/invoicePdf';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  invoice_number: '2026-000001',
  status: 'ISSUED',
  issue_date: '2026-09-02',
  due_date: '2026-09-16',
  currency_code: 'EUR',
  payment_reference: '20260000013',
  subtotal: '500.00',
  tax_total: '100.00',
  total: '600.00',
  seller_legal_name: 'Tilivo QA Tenant Oy',
  seller_business_id: 'FI12345678',
  bank_iban: 'FI21 1234 5600 0007 85',
  bank_bic: 'OKOYFIHH',
  bank_account_holder: 'Tilivo Oy',
  customer_snapshot: {
    name: 'Acme Customer Oy',
    business_id: 'FI87654321',
    vat_id: 'FI87654321',
    address_line1: 'Testikatu 1',
    postal_code: '00100',
    city: 'Helsinki',
    country_code: 'FI',
    email: 'billing@acme.example',
    language: 'fi',
  },
  lines: [
    {
      description: 'Consulting services September',
      quantity: '1',
      unit: 'h',
      unit_price: '600.00',
      net_amount: '500.00',
      tax_rate_snapshot: '20.0000',
      tax_code_snapshot: 'FI20',
      tax_amount: '100.00',
      gross_amount: '600.00',
    },
  ],
};

function pdfText(buffer: Buffer): string {
  return buffer
    .toString('latin1')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

describe('multilingual sales PDF renderer', () => {
  it('renders Finnish labels and bank details', () => {
    const text = pdfText(renderInvoicePdf({ ...base, language: 'fi' }));
    expect(text).toContain('LASKU 2026-000001');
    expect(text).toContain('Eräpäivä:');
    expect(text).toContain('Maksuviite: 20260000013');
    expect(text).toContain('FI21 1234 5600 0007 85');
    expect(text).toContain('OKOYFIHH');
    expect(text).toContain('Tilivo Oy');
  });

  it('renders English labels by default and as explicit language', () => {
    const text = pdfText(renderInvoicePdf({ ...base, language: 'en' }));
    expect(text).toContain('INVOICE 2026-000001');
    expect(text).toContain('Due date:');
    expect(text).toContain('Amount due');
    expect(text).toContain('IBAN:');
    expect(text).toContain('FI21 1234 5600 0007 85');
  });

  it('renders Estonian labels and advance-invoice title', () => {
    const text = pdfText(renderInvoicePdf({
      ...base,
      language: 'et',
      document_type: 'ADVANCE_INVOICE',
    }));
    expect(text).toContain('ETTEMAKSUARVE 2026-000001');
    expect(text).toContain('Maksetähtaeg:');
    expect(text).toContain('Viitenumber: 20260000013');
  });

  it('renders credit note heading with its own language', () => {
    const text = pdfText(renderInvoicePdf({
      ...base,
      language: 'fi',
      document_type: 'SALES_CREDIT_NOTE',
      credit_of_invoice_id: base.id,
      invoice_number: '2026-000002',
    }));
    expect(text).toContain('HYVITYSLASKU 2026-000002');
  });

  it('shows invoice discount and advance applied amounts', () => {
    const text = pdfText(renderInvoicePdf({
      ...base,
      language: 'en',
      discount_percent: '10.00',
      discount_amount: '10.00',
      subtotal: '90.00',
      tax_total: '18.00',
      total: '108.00',
      advance_applied: '108.00',
    }));
    expect(text).toContain('Discount (10.00%)');
    expect(text).toContain('Advance applied');
  });

  it('renders a deterministic reminder PDF with fee, interest and payment data', () => {
    const first = renderReminderPdf({
      invoice: { ...base, language: 'en' },
      reminder: {
        reminder_number: 'REM-2026-000001-1',
        created_at: '2026-10-02T00:00:00.000Z',
        amount_due: '400.00',
        fee_amount: '5.00',
        interest_amount: '3.11',
        interest_rate: '9.500000',
        interest_days: 14,
        language: 'en',
        note: 'Please settle the overdue amount.',
      },
    });
    const second = renderReminderPdf({
      invoice: { ...base, language: 'en' },
      reminder: {
        reminder_number: 'REM-2026-000001-1',
        created_at: '2026-10-02T00:00:00.000Z',
        amount_due: '400.00',
        fee_amount: '5.00',
        interest_amount: '3.11',
        interest_rate: '9.500000',
        interest_days: 14,
        language: 'en',
        note: 'Please settle the overdue amount.',
      },
    });
    expect(first.equals(second)).toBe(true);
    const text = pdfText(first);
    expect(text).toContain('REMINDER REM-2026-000001-1');
    expect(text).toContain('Original invoice: 2026-000001');
    expect(text).toContain('Reminder fee');
    expect(text).toContain('Late interest');
    expect(text).toContain('FI21 1234 5600 0007 85');
  });
});
