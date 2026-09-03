import { AppError, ErrorCodes } from '../lib/errors';
import { parseSecureXml, pickArray, pickPath, pickText } from '../lib/secureXml';

export type EinvoiceFormat = 'FINVOICE' | 'PEPPOL' | 'TEAPPSXML';

export interface CanonicalPurchaseLine {
  description: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  netAmount: string | null;
  vatRate: string | null;
  vatType: string;
  taxAmount: string | null;
  grossAmount: string | null;
}

export interface CanonicalPurchaseInvoice {
  format: EinvoiceFormat;
  sourceExternalId: string;
  supplier: {
    name: string;
    businessId: string;
    vatId: string;
    address: string;
    country: string;
    iban: string;
    eInvoiceAddress: string;
    eInvoiceOperator: string;
  };
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  supplierReference: string;
  paymentReference: string;
  lines: CanonicalPurchaseLine[];
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') value = text;
  }
  const text = String(value).trim();
  return text || null;
}

function requireField(value: unknown, name: string): string {
  const text = textOrNull(value);
  if (!text) throw new AppError(ErrorCodes.missingRequiredField, `Missing required field: ${name}`, 400);
  return text;
}

export function normalizeSupplierInvoiceNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function currencyOf(value: unknown, fallback = 'EUR'): string {
  const currency = textOrNull(value) ?? fallback;
  return currency.toUpperCase().slice(0, 3);
}

function decimalOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new AppError(ErrorCodes.invalidXml, `Invalid decimal value: ${text}`, 400);
  }
  return text;
}

function dateOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AppError(ErrorCodes.invalidXml, `Invalid date value: ${text}`, 400);
  }
  return text;
}

function pickFirst(root: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    const value = pickPath(root, path);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Finvoice (documented minimum profile)
// ---------------------------------------------------------------------------
export function parseFinvoiceXml(content: string | Buffer): CanonicalPurchaseInvoice {
  const root = parseSecureXml(content);
  const invoice = (pickPath(root, 'Finvoice') as Record<string, unknown>) ?? root;
  const invoiceNumber = requireField(pickPath(invoice, 'InvoiceDetails.InvoiceNumber'), 'InvoiceNumber');
  const invoiceDate = requireField(
    pickFirst(invoice, ['InvoiceDetails.InvoiceDate', 'InvoiceDetails.InvoiceDate.DateTime']),
    'InvoiceDate',
  );
  const seller = (pickPath(invoice, 'SellerPartyDetails') as Record<string, unknown>) ?? {};
  const invoiceRows = pickArray(invoice, 'InvoiceRow');
  const lines: CanonicalPurchaseLine[] = invoiceRows.map((row) => {
    const quantity = textOrNull(pickFirst(row, ['Quantity', 'InvoiceRow.Quantity']));
    const unitPrice = decimalOrNull(pickFirst(row, ['UnitPriceAmount', 'UnitPriceVatExcludedAmount']));
    const net = decimalOrNull(pickFirst(row, ['RowVatExcludedAmount', 'RowAmount']));
    const gross = decimalOrNull(pickPath(row, 'RowVatIncludedAmount'));
    const rate = textOrNull(pickPath(row, 'RowVatRatePercent'));
    const tax = decimalOrNull(pickPath(row, 'RowVatRateAmount'));
    const netValue = net ?? (quantity && unitPrice ? String(Number(quantity) * Number(unitPrice)) : null);
    const grossValue = gross ?? (netValue && rate ? String(Number(netValue) * (1 + Number(rate) / 100)) : netValue);
    const taxValue = tax ?? (netValue && rate ? String(Number(netValue) * Number(rate) / 100) : '0');
    return {
      description: textOrNull(pickFirst(row, ['ArticleName', 'ArticleDescription'])) ?? '',
      quantity,
      unit: textOrNull(pickPath(row, 'UnitPriceUnitCode')),
      unitPrice,
      netAmount: netValue ? Number(netValue).toFixed(2) : null,
      vatRate: rate,
      vatType: 'VAT',
      taxAmount: taxValue ? Number(taxValue).toFixed(2) : null,
      grossAmount: grossValue ? Number(grossValue).toFixed(2) : null,
    };
  });
  return {
    format: 'FINVOICE',
    sourceExternalId: invoiceNumber,
    supplier: {
      name: pickText(seller, 'SellerPartyDetails.SellerName') || pickText(seller, 'SellerName'),
      businessId: pickText(seller, 'SellerPartyIdentifier'),
      vatId: pickText(seller, 'SellerVatID'),
      address: [
        pickText(seller, 'SellerAddress.AddressLine1'),
        pickText(seller, 'SellerAddress.AddressLine2'),
      ].filter(Boolean).join(', '),
      country: pickText(seller, 'SellerAddress.CountryCode'),
      iban: pickText(seller, 'SellerAccountDetails.AccountNumber') || pickText(seller, 'SellerIBAN'),
      eInvoiceAddress: pickText(seller, 'SellerPartyDetails.SellerOvTunnus'),
      eInvoiceOperator: pickText(seller, 'SellerPartyDetails.SellerOperator'),
    },
    invoiceNumber,
    invoiceDate: dateOrNull(invoiceDate)!,
    dueDate: dateOrNull(pickPath(invoice, 'InvoiceDetails.InvoiceDueDate')),
    currency: currencyOf(pickPath(invoice, 'InvoiceDetails.InvoiceCurrencyCode')),
    supplierReference: pickText(invoice, 'InvoiceDetails.InvoiceReference'),
    paymentReference: pickText(invoice, 'InvoiceDetails.PaymentReference') || pickText(invoice, 'PaymentReferenceDetails.RFCode'),
    lines,
    subtotal: decimalOrNull(pickPath(invoice, 'InvoiceDetails.InvoiceTotalVatExcluded')),
    taxTotal: decimalOrNull(pickPath(invoice, 'InvoiceDetails.InvoiceTotalVatIncluded')), // fallback only
    total: decimalOrNull(pickPath(invoice, 'InvoiceDetails.InvoiceTotalVatIncluded')),
  };
}

// ---------------------------------------------------------------------------
// PEPPOL BIS 3.0 (minimum ingestion profile)
// ---------------------------------------------------------------------------
export function parsePeppolBisXml(content: string | Buffer): CanonicalPurchaseInvoice {
  const root = parseSecureXml(content);
  const invoice = (pickPath(root, 'Invoice') as Record<string, unknown>) ?? root;
  const supplierParty = (pickPath(invoice, 'AccountingSupplierParty.Party') as Record<string, unknown>) ?? {};
  const legal = (pickPath(supplierParty, 'PartyLegalEntity') as Record<string, unknown>) ?? {};
  const taxScheme = (pickPath(supplierParty, 'PartyTaxScheme') as Record<string, unknown>) ?? {};
  const invoiceNumber = requireField(pickPath(invoice, 'ID'), 'Invoice.ID');
  const invoiceDate = requireField(pickPath(invoice, 'IssueDate'), 'Invoice.IssueDate');
  const rawLines = pickArray(invoice, 'InvoiceLine');
  const lines: CanonicalPurchaseLine[] = rawLines.map((line) => {
    const classified = (pickPath(line, 'Item.ClassifiedTaxCategory') as Record<string, unknown>) ?? {};
    const quantity = textOrNull(pickPath(line, 'InvoicedQuantity'));
    const unit = textOrNull(pickPath(line, 'InvoicedQuantity.@_unitCode'));
    const unitPrice = decimalOrNull(pickPath(line, 'Price.PriceAmount'));
    const rate = textOrNull(pickPath(classified, 'Percent'));
    const net = decimalOrNull(pickPath(line, 'LineExtensionAmount'));
    const netValue = net ?? (quantity && unitPrice ? String(Number(quantity) * Number(unitPrice)) : null);
    const tax = netValue && rate ? String((Number(netValue) * Number(rate)) / 100).slice(0, 20) : '0';
    return {
      description: textOrNull(pickPath(line, 'Item.Name')) ?? '',
      quantity,
      unit,
      unitPrice,
      netAmount: netValue ? Number(netValue).toFixed(2) : null,
      vatRate: rate,
      vatType: pickText(classified, 'ID') === 'AE' ? 'REVERSE_CHARGE' : 'VAT',
      taxAmount: Number(tax).toFixed(2),
      grossAmount:
        netValue && rate ? Number(Number(netValue) * (1 + Number(rate) / 100)).toFixed(2) : netValue,
    };
  });
  const monetary = (pickPath(invoice, 'LegalMonetaryTotal') as Record<string, unknown>) ?? {};
  return {
    format: 'PEPPOL',
    sourceExternalId: invoiceNumber,
    supplier: {
      name: pickText(legal, 'RegistrationName'),
      businessId: pickText(taxScheme, 'CompanyID'),
      vatId: pickText(taxScheme, 'CompanyID'),
      address: [
        pickText(asRecord(pickPath(supplierParty, 'PostalAddress')), 'StreetName'),
        pickText(asRecord(pickPath(supplierParty, 'PostalAddress')), 'CityName'),
      ].filter(Boolean).join(', '),
      country: pickText(asRecord(pickPath(supplierParty, 'PostalAddress')), 'Country.IdentificationCode'),
      iban: '',
      eInvoiceAddress: pickText(supplierParty, 'EndpointID'),
      eInvoiceOperator: '',
    },
    invoiceNumber,
    invoiceDate: dateOrNull(invoiceDate)!,
    dueDate: dateOrNull(pickPath(invoice, 'PaymentMeans.PaymentDueDate')),
    currency: currencyOf(pickPath(invoice, 'DocumentCurrencyCode')),
    supplierReference: pickText(invoice, 'AccountingSupplierParty.Party.PartyIdentification.ID'),
    paymentReference: pickText(invoice, 'PaymentMeans.PaymentID'),
    lines,
    subtotal: decimalOrNull(pickPath(monetary, 'TaxExclusiveAmount')),
    taxTotal: decimalOrNull(pickPath(monetary, 'TaxTotal.TaxAmount')),
    total: decimalOrNull(pickPath(monetary, 'PayableAmount')),
  };
}

// ---------------------------------------------------------------------------
// TEAPPSXML (documented minimum profile)
// ---------------------------------------------------------------------------
export function parseTeappsXml(content: string | Buffer): CanonicalPurchaseInvoice {
  const root = parseSecureXml(content);
  const envelope = (pickPath(root, 'TEAPPSXML') as Record<string, unknown>) ?? root;
  const invoice = (pickPath(envelope, 'Invoice') as Record<string, unknown>) ?? envelope;
  const supplier = (pickPath(invoice, 'Supplier') as Record<string, unknown>) ?? {};
  const invoiceNumber = requireField(
    pickFirst(invoice, ['InvoiceNumber', 'InvoiceDetails.InvoiceNumber', 'ID']),
    'InvoiceNumber',
  );
  const invoiceDate = requireField(
    pickFirst(invoice, ['InvoiceDate', 'InvoiceDetails.InvoiceDate', 'IssueDate']),
    'InvoiceDate',
  );
  const rawLines = pickArray(invoice, 'Lines.Line');
  const lines: CanonicalPurchaseLine[] = rawLines.map((line) => {
    const quantity = textOrNull(pickPath(line, 'Quantity'));
    const unitPrice = decimalOrNull(pickPath(line, 'UnitPrice'));
    const rate = textOrNull(pickPath(line, 'VatPercent'));
    const net = decimalOrNull(pickPath(line, 'NetAmount'));
    const netValue = net ?? (quantity && unitPrice ? String(Number(quantity) * Number(unitPrice)) : null);
    const tax = netValue && rate ? String((Number(netValue) * Number(rate)) / 100).slice(0, 20) : '0';
    return {
      description: textOrNull(pickPath(line, 'Description')) ?? '',
      quantity,
      unit: textOrNull(pickPath(line, 'Unit')),
      unitPrice,
      netAmount: netValue ? Number(netValue).toFixed(2) : null,
      vatRate: rate,
      vatType: 'VAT',
      taxAmount: Number(tax).toFixed(2),
      grossAmount:
        netValue && rate ? Number(Number(netValue) * (1 + Number(rate) / 100)).toFixed(2) : netValue,
    };
  });
  return {
    format: 'TEAPPSXML',
    sourceExternalId: invoiceNumber,
    supplier: {
      name: pickText(supplier, 'Name'),
      businessId: pickText(supplier, 'BusinessId'),
      vatId: pickText(supplier, 'VatId'),
      address: pickText(supplier, 'Address'),
      country: pickText(supplier, 'Country'),
      iban: pickText(supplier, 'IBAN'),
      eInvoiceAddress: pickText(supplier, 'EInvoiceAddress'),
      eInvoiceOperator: pickText(supplier, 'Operator'),
    },
    invoiceNumber,
    invoiceDate: dateOrNull(invoiceDate)!,
    dueDate: dateOrNull(pickPath(invoice, 'DueDate')),
    currency: currencyOf(pickPath(invoice, 'Currency')),
    supplierReference: pickText(invoice, 'Reference'),
    paymentReference: pickText(invoice, 'PaymentReference'),
    lines,
    subtotal: decimalOrNull(pickPath(invoice, 'Subtotal')),
    taxTotal: decimalOrNull(pickPath(invoice, 'TaxTotal')),
    total: decimalOrNull(pickPath(invoice, 'Total')),
  };
}

export function parseEinvoice(
  format: EinvoiceFormat,
  content: string | Buffer,
): CanonicalPurchaseInvoice {
  if (format === 'FINVOICE') return parseFinvoiceXml(content);
  if (format === 'PEPPOL') return parsePeppolBisXml(content);
  if (format === 'TEAPPSXML') return parseTeappsXml(content);
  throw new AppError(ErrorCodes.unsupportedFormat, 'Unsupported e-invoice format', 400);
}
