/**
 * v0.10 document OCR abstraction.
 *
 * Providers return a normalized `OcrResult`; the rest of the application
 * never parses provider-specific payloads. Tests and local/dev runs use the
 * deterministic mock provider, so CI never depends on a live OCR service.
 */

export type OcrStatus =
  | 'NOT_REQUESTED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'FAILED';

export interface OcrLine {
  description?: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  netAmount?: string;
  taxRate?: string;
  taxAmount?: string;
  taxType?: string;
}

export interface OcrResult {
  provider: string;
  supplierName?: string;
  businessId?: string;
  vatNumber?: string;
  documentNumber?: string;
  date?: string;
  dueDate?: string;
  total?: string;
  net?: string;
  vatTotal?: string;
  iban?: string;
  reference?: string;
  currency?: string;
  paymentMethod?: 'BANK_TRANSFER' | 'COMPANY_CARD' | 'CASH' | 'PERSONAL_CARD' | 'EMPLOYEE_PAID' | 'OTHER';
  description?: string;
  lines: OcrLine[];
  confidence: Record<string, number>;
  rawMetadata?: Record<string, unknown>;
}

export interface DocumentOcrProvider {
  readonly name: string;
  extract(input: {
    originalFilename: string;
    mimeType: string;
    data: Buffer;
  }): Promise<OcrResult>;
}

function confidence(value: number): number {
  return Math.min(1, Math.max(0, Number(value)));
}

function byFilename(filename: string, needle: string): boolean {
  return filename.toLowerCase().includes(needle);
}

/**
 * Deterministic provider used by dev/test. Fixtures encode their intent in
 * the filename; no image parsing is attempted.
 */
export class MockDocumentOcrProvider implements DocumentOcrProvider {
  readonly name = 'mock';

  async extract(input: { originalFilename: string; mimeType: string; data: Buffer }): Promise<OcrResult> {
    const filename = String(input.originalFilename ?? '');
    if (byFilename(filename, 'malformed')) {
      throw new Error('Malformed OCR provider response (mock)');
    }
    if (byFilename(filename, 'multi')) {
      return {
        provider: this.name,
        supplierName: 'Mock Multi Cafe Oy',
        businessId: 'FI12345678',
        vatNumber: 'FI12345678',
        documentNumber: 'MULTI-001',
        date: '2026-09-10',
        total: '119.50',
        net: '100.00',
        vatTotal: '19.50',
        currency: 'EUR',
        paymentMethod: 'COMPANY_CARD',
        lines: [
          { description: 'Electronics', netAmount: '50.00', taxRate: '25.5', taxAmount: '12.75' },
          { description: 'Groceries', netAmount: '50.00', taxRate: '13.5', taxAmount: '6.75' },
        ],
        confidence: {
          supplier_name: confidence(0.99),
          total: confidence(0.94),
          date: confidence(0.92),
        },
        rawMetadata: { fixture: 'multi-rate' },
      };
    }
    if (byFilename(filename, 'lowconf')) {
      return {
        provider: this.name,
        supplierName: 'Unclear Kiosk',
        documentNumber: 'KIOSK-1',
        date: '2026-09-11',
        total: '12.30',
        net: '9.80',
        vatTotal: '2.50',
        currency: 'EUR',
        paymentMethod: 'CASH',
        lines: [{ description: 'Unknown item', netAmount: '9.80', taxRate: '25.5', taxAmount: '2.50' }],
        confidence: {
          supplier_name: confidence(0.41),
          total: confidence(0.88),
          date: confidence(0.55),
        },
      };
    }
    if (byFilename(filename, 'receipt')) {
      return {
        provider: this.name,
        supplierName: byFilename(filename, 'cafe') ? 'Mock Cafe Oy' : 'Mock Merchant Oy',
        businessId: 'FI12345678',
        vatNumber: 'FI12345678',
        documentNumber: 'REC-1001',
        date: '2026-09-10',
        dueDate: '2026-09-10',
        total: '125.50',
        net: '100.00',
        vatTotal: '25.50',
        iban: 'FI2112345600000785',
        reference: '1234',
        currency: 'EUR',
        paymentMethod: 'CASH',
        lines: [{ description: 'Office supplies', netAmount: '100.00', taxRate: '25.5', taxAmount: '25.50' }],
        confidence: {
          supplier_name: confidence(0.98),
          total: confidence(0.97),
          date: confidence(0.96),
        },
        rawMetadata: { fixture: 'receipt' },
      };
    }
    if (byFilename(filename, 'invoice')) {
      return {
        provider: this.name,
        supplierName: 'Mock Supplier Oy',
        businessId: 'FI12345678',
        vatNumber: 'FI12345678',
        documentNumber: 'INV-2026-1',
        date: '2026-09-10',
        dueDate: '2026-10-10',
        total: '1255.00',
        net: '1000.00',
        vatTotal: '255.00',
        currency: 'EUR',
        paymentMethod: 'BANK_TRANSFER',
        lines: [{ description: 'Consulting', netAmount: '1000.00', taxRate: '25.5', taxAmount: '255.00' }],
        confidence: { supplier_name: confidence(0.99), total: confidence(0.99), date: confidence(0.99) },
      };
    }
    return {
      provider: this.name,
      supplierName: 'Generic Mock Vendor',
      documentNumber: 'GEN-1',
      date: '2026-09-10',
      total: '10.00',
      net: '10.00',
      vatTotal: '0.00',
      currency: 'EUR',
      lines: [{ description: 'Generic expense', netAmount: '10.00', taxRate: '0', taxAmount: '0.00' }],
      confidence: {},
    };
  }
}

export function createDocumentOcrProvider(driver: string | undefined): DocumentOcrProvider {
  const value = String(driver ?? 'mock').toLowerCase();
  if (value === 'none' || value === 'noop') {
    return new MockDocumentOcrProvider(); // noop still returns mock for local UX
  }
  return new MockDocumentOcrProvider();
}
