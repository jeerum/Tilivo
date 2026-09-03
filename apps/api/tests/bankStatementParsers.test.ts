import { describe, expect, it } from 'vitest';
import { parseBankCsv, parseCamt053 } from '../src/services/bankStatementParsers';

const csv = `Booking date;Reference;Counterparty;Amount;Message
2026-09-01;20260000013;Acme Customer Oy;1250,00;Invoice 2026-000013
2026-09-02;40000000009;Supplier Oy;-3000,00;Purchase payment`;

const camt = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <Stmt>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt>1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
      <Ntry><CdtDbtInd>CRDT</CdtDbtInd><Amt>250.00</Amt><BookgDt><Dt>2026-09-10</Dt></BookgDt><ValDt><Dt>2026-09-10</Dt></ValDt><AcctSvcrRef>TX1</AcctSvcrRef>
        <NtryDtls><TxDtls><Refs><EndToEndId>20260000013</EndToEndId></Refs>
          <RltdPties><Dbtr><Nm>Acme Customer Oy</Nm><Acct><Id><IBAN>FI2112345600000785</IBAN></Id></Acct></Dbtr></RltdPties>
        </TxDtls></NtryDtls></Ntry>
      <Ntry><CdtDbtInd>DBIT</CdtDbtInd><Amt>10.00</Amt><BookgDt><Dt>2026-09-11</Dt></BookgDt><AcctSvcrRef>TX2</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Bank Oy</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('bank statement parsers', () => {
  it('parses semicolon CSV with Finnish headers and signed amounts', () => {
    const result = parseBankCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.direction).toBe('IN');
    expect(result.rows[0]!.amount).toBe('1250.00');
    expect(result.rows[0]!.reference).toBe('20260000013');
    expect(result.rows[1]!.direction).toBe('OUT');
    expect(result.rows[1]!.amount).toBe('3000.00');
  });

  it('parses comma CSV with English headers and debit/credit columns', () => {
    const comma = `Date,Value date,Debit,Credit,Reference,Description,Counterparty,Transaction id
2026-09-05,2026-09-05,,50.00,RF0812345678,Test message,Person Oy,TX99`;
    const result = parseBankCsv(comma);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.direction).toBe('IN');
    expect(result.rows[0]!.externalTransactionId).toBe('TX99');
  });

  it('parses CAMT.053 entries and balances', () => {
    const result = parseCamt053(camt);
    expect(result.errors).toEqual([]);
    expect(result.openingBalance).toBe('1000.00');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.direction).toBe('IN');
    expect(result.rows[0]!.counterpartyIban).toBe('FI2112345600000785');
    expect(result.rows[0]!.bookingDate).toBe('2026-09-10');
    expect(result.rows[1]!.direction).toBe('OUT');
  });

  it('rejects XML with external entities', () => {
    const result = parseCamt053('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>');
    expect(result.errors.join(' ')).toContain('External entities');
  });

  it('rejects CSVs without required headers', () => {
    const result = parseBankCsv('Foo;Bar\n1;2');
    expect(result.errors).toHaveLength(1);
  });
});
