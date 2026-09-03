import { XMLParser } from 'fast-xml-parser';
import { normalizeIban, normalizePaymentReference } from '../lib/bankNormalization';

export interface NormalizedBankTransaction {
  externalTransactionId?: string | null;
  bookingDate: string;
  valueDate?: string | null;
  amount: string;
  currency: string;
  direction: 'IN' | 'OUT';
  counterpartyName?: string | null;
  counterpartyIban?: string | null;
  reference?: string | null;
  message?: string | null;
  bankArchiveId?: string | null;
}

export interface BankStatementParseResult {
  parserType: 'GENERIC_CSV' | 'CAMT053';
  rows: NormalizedBankTransaction[];
  warnings: string[];
  errors: string[];
  statementFrom?: string | null;
  statementTo?: string | null;
  openingBalance?: string | null;
  closingBalance?: string | null;
}

function asDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return raw.slice(0, 10);
}

function parseAmount(value: string): number {
  let cleaned = String(value ?? '').trim().replace(/\s/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitCsvLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

const HEADER_ALIASES: Record<string, string[]> = {
  date: ['date', 'päivä', 'päivämäärä', 'kuupäev', 'kirjauspäivä', 'kirjauspvm', 'booking date', 'tapahtumapäivä', 'arvelduspäev'],
  valueDate: ['value date', 'arvopäivä', 'väärtuspäev', 'valuedate'],
  amount: ['amount', 'summa', 'määrä', 'belopp', 'rahasumma', 'sum'],
  debit: ['debit', 'veloitus', 'deebet', 'debit amount'],
  credit: ['credit', 'hyvitys', 'kreedit', 'credit amount'],
  direction: ['direction', 'suunta', 'type', 'tyyppi', 'tüüp'],
  reference: ['reference', 'viite', 'viitenumero', 'viitenumber', 'rf reference', 'payment reference', 'makseviide'],
  message: ['message', 'selite', 'kirjeldus', 'text', 'kuvaus', 'memo'],
  counterparty: ['counterparty', 'saaja', 'maksaja', 'vastapuoli', 'partner', 'name', 'saaja/maksaja'],
  counterpartyIban: ['counterparty iban', 'saajan iban', 'maksajan iban', 'iban'],
  transactionId: ['transaction id', 'tapahtumatunnus', 'id', 'transaction', 'viitenumero2'],
};

function mapHeader(header: string): string | null {
  const normalized = header.toLowerCase().replace(/[^a-zäöõü0-9 ]/g, '').trim();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

export function parseBankCsv(content: string): BankStatementParseResult {
  const text = String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const result: BankStatementParseResult = { parserType: 'GENERIC_CSV', rows: [], warnings: [], errors: [] };
  if (lines.length < 2) {
    result.errors.push('CSV requires a header and at least one data row');
    return result;
  }
  const separator = (lines[0]!.match(/;/g)?.length ?? 0) >= (lines[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const headers = splitCsvLine(lines[0]!, separator).map((header) => mapHeader(header));
  const hasAmount = headers.includes('amount') || headers.includes('debit') || headers.includes('credit');
  if (!headers.includes('date') || !hasAmount) {
    result.errors.push('CSV headers must include a date and an amount (or debit/credit) column');
    return result;
  }
  const indexOf = (key: string) => headers.indexOf(key);
  for (const [lineIndex, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line, separator);
    const at = (key: string): string | undefined => {
      const index = indexOf(key);
      return index >= 0 ? cells[index]?.trim() : undefined;
    };
    const rawAmount = parseAmount(at('amount') ?? '0');
    const debit = parseAmount(at('debit') ?? '0');
    const credit = parseAmount(at('credit') ?? '0');
    const amount = debit > 0 ? debit : credit > 0 ? credit : Math.abs(rawAmount);
    if (amount <= 0) {
      result.warnings.push(`Row ${lineIndex + 2}: skipped zero/negative amount`);
      continue;
    }
    const directionRaw = String(at('direction') ?? '').toUpperCase();
    let direction: 'IN' | 'OUT' = rawAmount < 0 ? 'OUT' : 'IN';
    if (debit > 0) direction = 'OUT';
    else if (credit > 0) direction = 'IN';
    if (directionRaw.includes('OUT') || directionRaw.includes('DEBIT') || directionRaw.includes('VELOITUS') || directionRaw.includes('DEEBET')) {
      direction = 'OUT';
    } else if (directionRaw.includes('IN') || directionRaw.includes('CREDIT') || directionRaw.includes('HYVITYS') || directionRaw.includes('KREEDIT')) {
      direction = 'IN';
    }
    result.rows.push({
      externalTransactionId: at('transactionId') || null,
      bookingDate: asDate(at('date')) ?? '',
      valueDate: asDate(at('valueDate')),
      amount: amount.toFixed(2),
      currency: 'EUR',
      direction,
      counterpartyName: at('counterparty') || null,
      counterpartyIban: at('counterpartyIban') ? normalizeIban(at('counterpartyIban')!) : null,
      reference: at('reference') ? normalizePaymentReference(at('reference')!) : null,
      message: at('message') || null,
    });
  }
  if (result.errors.length === 0 && result.rows.length === 0) {
    result.errors.push('No valid transactions found');
  }
  return result;
}

function allElements(node: any, tag: string, found: any[] = []): any[] {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag) {
      if (Array.isArray(value)) found.push(...value);
      else found.push(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) allElements(item, tag, found);
    } else if (value && typeof value === 'object') {
      allElements(value, tag, found);
    }
  }
  return found;
}

function textOf(node: any, ...keys: string[]): string | null {
  if (!node || typeof node !== 'object') return null;
  for (const key of keys) {
    const value = node[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

export function parseCamt053(xml: string): BankStatementParseResult {
  const result: BankStatementParseResult = { parserType: 'CAMT053', rows: [], warnings: [], errors: [] };
  if (!String(xml ?? '').includes('<')) {
    result.errors.push('Not an XML document');
    return result;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(String(xml))) {
    result.errors.push('External entities are not allowed');
    return result;
  }
  let parsed: any;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(xml);
  } catch (error) {
    result.errors.push(`Invalid XML: ${error instanceof Error ? error.message.slice(0, 200) : 'parse error'}`);
    return result;
  }
  const statements = allElements(parsed, 'Stmt');
  for (const statement of statements) {
    const account = statement.Acct?.Id?.IBAN;
    void account;
    const balances = allElements(statement, 'Bal');
    for (const balance of balances) {
      const type = textOf(balance?.Tp?.CdOrPrtry, 'Cd') ?? '';
      const sign = textOf(balance, 'CdtDbtInd') ?? '';
      const amount = textOf(balance, 'Amt') ?? '';
      if (type === 'OPBD' || type === 'CLBD') {
        const signed = sign === 'DBIT' && amount ? `-${amount}` : amount;
        if (type === 'OPBD') result.openingBalance = signed;
        else result.closingBalance = signed;
      }
    }
    const entries = allElements(statement, 'Ntry');
    for (const entry of entries) {
      const sign = textOf(entry, 'CdtDbtInd') ?? 'CRDT';
      const direction = sign === 'DBIT' ? 'OUT' : 'IN';
      const amountValue = parseAmount(textOf(entry, 'Amt') ?? '0');
      if (amountValue <= 0) continue;
      const details = entry.NtryDtls?.TxDtls ?? {};
      const bookRaw = textOf(entry.BookgDt, 'Dt') ?? textOf(entry, 'BookgDt') ?? '';
      const valueRaw = textOf(entry.ValDt, 'Dt') ?? textOf(entry, 'ValDt') ?? '';
      const parties = details.RltdPties ?? {};
      const payer = sign === 'DBIT' ? parties.Cdtr : parties.Dbtr;
      const payerName = payer?.Nm ?? parties?.Cdtr?.Nm ?? parties?.Dbtr?.Nm ?? null;
      const payerIban = payer?.Acct?.Id?.IBAN ?? parties?.Cdtr?.Acct?.Id?.IBAN ?? parties?.Dbtr?.Acct?.Id?.IBAN ?? null;
      const remittance = textOf(details.RmtInf?.Ustrd) ?? textOf(entry.RmtInf?.Ustrd) ?? null;
      const reference = textOf(details.Refs?.EndToEndId) ?? textOf(entry.Refs?.EndToEndId) ?? textOf(entry, 'AcctSvcrRef') ?? null;
      const externalId = textOf(entry, 'AcctSvcrRef') ?? textOf(entry.Refs?.AcctSvcrRef) ?? null;
      const message = [textOf(entry, 'AddtlNtryInf'), remittance].filter(Boolean).join(' ') || null;
      result.rows.push({
        externalTransactionId: externalId,
        bookingDate: asDate(bookRaw) ?? '',
        valueDate: asDate(valueRaw),
        amount: amountValue.toFixed(2),
        currency: textOf(entry, 'Amt') ? 'EUR' : 'EUR',
        direction,
        counterpartyName: payerName,
        counterpartyIban: payerIban ? normalizeIban(payerIban) : null,
        reference: reference ? normalizePaymentReference(reference) : null,
        message,
        bankArchiveId: textOf(entry.Refs?.AcctSvcrRef) ?? null,
      });
    }
  }
  if (result.rows.length === 0) result.errors.push('No CAMT.053 entries found');
  return result;
}
