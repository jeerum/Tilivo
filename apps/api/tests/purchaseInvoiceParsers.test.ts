import { describe, expect, it } from 'vitest';
import {
  normalizeSupplierInvoiceNumber,
  parseEinvoice,
  parseFinvoiceXml,
  parsePeppolBisXml,
  parseTeappsXml,
} from '../src/services/purchaseInvoiceParsers';
import { parseSecureXml } from '../src/lib/secureXml';
import { AppError, ErrorCodes } from '../src/lib/errors';

const finvoice = `
<?xml version="1.0" encoding="UTF-8"?>
<Finvoice Version="3.0">
  <InvoiceDetails>
    <InvoiceNumber>FV-2026-001</InvoiceNumber>
    <InvoiceDate>2026-09-01</InvoiceDate>
    <InvoiceDueDate>2026-09-30</InvoiceDueDate>
    <InvoiceCurrencyCode>EUR</InvoiceCurrencyCode>
    <InvoiceReference>PO-2026-9</InvoiceReference>
    <InvoiceTotalVatExcluded>1000.00</InvoiceTotalVatExcluded>
    <InvoiceTotalVatIncluded>1240.00</InvoiceTotalVatIncluded>
  </InvoiceDetails>
  <SellerPartyDetails>
    <SellerPartyIdentifier>FI12345678</SellerPartyIdentifier>
    <SellerName>Supplier Test Oy</SellerName>
    <SellerVatID>FI12345678</SellerVatID>
    <SellerAddress>
      <AddressLine1>Tehdaskatu 1</AddressLine1>
      <AddressLine2>00210</AddressLine2>
      <CountryCode>FI</CountryCode>
    </SellerAddress>
  </SellerPartyDetails>
  <InvoiceRow>
    <ArticleName>Workshop tools</ArticleName>
    <Quantity>2</Quantity>
    <UnitPriceAmount>500.00</UnitPriceAmount>
    <RowVatExcludedAmount>1000.00</RowVatExcludedAmount>
    <RowVatRatePercent>24</RowVatRatePercent>
    <RowVatRateAmount>240.00</RowVatRateAmount>
    <RowVatIncludedAmount>1240.00</RowVatIncludedAmount>
  </InvoiceRow>
</Finvoice>`;

const peppol = `
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>PEPPOL-1001</cbc:ID>
  <cbc:IssueDate>2026-09-02</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0088">1234567890001</cbc:EndpointID>
      <cac:PartyLegalEntity><cbc:RegistrationName>Peppol Supplier Oy</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:PartyTaxScheme><cbc:CompanyID>FI98765432</cbc:CompanyID></cac:PartyTaxScheme>
      <cac:PostalAddress>
        <cbc:StreetName>Peppolikatu 2</cbc:StreetName>
        <cbc:CityName>Helsinki</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>FI</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount>500.00</cbc:LineExtensionAmount>
    <cac:Price><cbc:PriceAmount>500.00</cbc:PriceAmount></cac:Price>
    <cac:Item>
      <cbc:Name>Consulting</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>24</cbc:Percent>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
  </cac:InvoiceLine>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount>500.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount>500.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount>620.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount>620.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;

const teapps = `
<?xml version="1.0" encoding="UTF-8"?>
<TEAPPSXML Version="1.0">
  <Invoice>
    <InvoiceNumber>TE-2026-007</InvoiceNumber>
    <InvoiceDate>2026-09-03</InvoiceDate>
    <DueDate>2026-09-20</DueDate>
    <Currency>EUR</Currency>
    <Supplier>
      <Name>Teapps Supplier AS</Name>
      <BusinessId>EE10012345</BusinessId>
      <VatId>EE10012345</VatId>
      <Address>Narva mnt 5, Tallinn</Address>
      <Country>EE</Country>
      <IBAN>EE382200221020145685</IBAN>
    </Supplier>
    <Lines>
      <Line>
        <Description>Materials</Description>
        <Quantity>10</Quantity>
        <Unit>kg</Unit>
        <UnitPrice>19.99</UnitPrice>
        <VatPercent>24</VatPercent>
        <NetAmount>199.90</NetAmount>
      </Line>
    </Lines>
    <Subtotal>199.90</Subtotal>
    <TaxTotal>47.98</TaxTotal>
    <Total>247.88</Total>
  </Invoice>
</TEAPPSXML>`;

describe('e-invoice parsers map to the canonical model', () => {
  it('parses a Finvoice minimum profile', () => {
    const invoice = parseFinvoiceXml(finvoice);
    expect(invoice.format).toBe('FINVOICE');
    expect(invoice.invoiceNumber).toBe('FV-2026-001');
    expect(invoice.supplier.businessId).toBe('FI12345678');
    expect(invoice.supplier.name).toBe('Supplier Test Oy');
    expect(invoice.currency).toBe('EUR');
    expect(invoice.total).toBe('1240.00');
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]!.netAmount).toBe('1000.00');
    expect(invoice.lines[0]!.vatRate).toBe('24');
  });

  it('parses a PEPPOL BIS minimum profile', () => {
    const invoice = parsePeppolBisXml(peppol);
    expect(invoice.format).toBe('PEPPOL');
    expect(invoice.invoiceNumber).toBe('PEPPOL-1001');
    expect(invoice.supplier.vatId).toBe('FI98765432');
    expect(invoice.supplier.eInvoiceAddress).toBe('1234567890001');
    expect(invoice.lines[0]!.description).toBe('Consulting');
    expect(invoice.lines[0]!.quantity).toBe('1');
    expect(invoice.lines[0]!.vatRate).toBe('24');
    expect(invoice.total).toBe('620.00');
  });

  it('parses a TEAPPSXML minimum profile', () => {
    const invoice = parseTeappsXml(teapps);
    expect(invoice.format).toBe('TEAPPSXML');
    expect(invoice.invoiceNumber).toBe('TE-2026-007');
    expect(invoice.supplier.businessId).toBe('EE10012345');
    expect(invoice.lines[0]!.netAmount).toBe('199.90');
    expect(invoice.total).toBe('247.88');
  });

  it('routes through parseEinvoice', () => {
    expect(parseEinvoice('FINVOICE', finvoice).invoiceNumber).toBe('FV-2026-001');
    expect(parseEinvoice('PEPPOL', peppol).invoiceNumber).toBe('PEPPOL-1001');
    expect(parseEinvoice('TEAPPSXML', teapps).invoiceNumber).toBe('TE-2026-007');
  });

  it('normalizes supplier invoice numbers without destroying display values', () => {
    expect(normalizeSupplierInvoiceNumber(' INV-2026 / 001 ')).toBe('INV2026001');
  });
});

describe('XML parser security', () => {
  it('rejects DOCTYPE/ENTITY payloads (XXE and entity expansion)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Finvoice>&xxe;</Finvoice>`;
    expect(() => parseSecureXml(xxe)).toThrow(AppError);
    const entityBomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><Finvoice>&lol2;</Finvoice>`;
    expect(() => parseSecureXml(entityBomb)).toThrow(AppError);
  });

  it('rejects malformed XML and missing mandatory fields', () => {
    expect(() => parseFinvoiceXml('<Finvoice><InvoiceDetails></InvoiceDetails></Finvoice>')).toThrow(AppError);
    expect(() => parseSecureXml('<Finvoice><broken></Finvoice>')).toThrow(AppError);
  });

  it('rejects oversized XML', () => {
    const large = `<Finvoice>${'x'.repeat(1.1 * 1024 * 1024)}</Finvoice>`;
    expect(() => parseSecureXml(large)).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidXml }),
    );
  });

  it('does not read local files or external resources', async () => {
    const payload = `<?xml version="1.0"?><!DOCTYPE foo SYSTEM "file:///etc/passwd"><Finvoice/>`;
    expect(() => parseSecureXml(payload)).toThrow(AppError);
  });
});
