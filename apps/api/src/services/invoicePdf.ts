import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { fillLegalNote } from './vatEngineService';

/**
 * Deterministic, browser-free PDF rendering for issued sales invoices.
 *
 * Writes a minimal PDF 1.4 document using Courier core fonts (fixed advance
 * width, exact column layout) with WinAnsi text encoding. The same input
 * always produces the same bytes, which makes SHA-256 storage checks stable.
 */

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

interface TextRun {
  text: string;
  x: number;
  bold?: boolean;
  size?: number;
}

interface PdfRow {
  top: number;
  runs: TextRun[];
}

function latin1(text: string): string {
  return Buffer.from(text, 'latin1').toString('latin1');
}

function escapePdfText(text: string): string {
  const escaped: string[] = [];
  for (const character of latin1(text)) {
    const code = character.codePointAt(0)!;
    if (character === '\\') escaped.push('\\\\');
    else if (character === '(') escaped.push('\\(');
    else if (character === ')') escaped.push('\\)');
    else if (code < 32) escaped.push(' ');
    else escaped.push(character);
  }
  return escaped.join('');
}

function splitToWidth(text: string, maxChars: number): string[] {
  if (maxChars < 1) return [''];
  const clean = latin1(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

class PdfLayout {
  private readonly rows: PdfRow[] = [];
  private y = MARGIN;
  private readonly pageBreaks: number[] = [];

  private ensureSpace(needed: number): void {
    if (this.y + needed <= PAGE_HEIGHT - MARGIN) return;
    this.pageBreaks.push(this.rows.length);
    this.y = MARGIN;
  }

  private push(runs: TextRun[], size: number, gap: number): void {
    this.ensureSpace(gap);
    this.rows.push({ top: this.y, runs });
    this.y += gap;
  }

  line(text: string, options: { bold?: boolean; size?: number; gap?: number } = {}): void {
    const size = options.size ?? 10;
    this.push([{ text: latin1(text), x: MARGIN, bold: options.bold, size }], size, options.gap ?? size + 3);
  }

  wrap(text: string, widthChars: number, options: { bold?: boolean; size?: number; gap?: number } = {}): void {
    const size = options.size ?? 10;
    const gap = options.gap ?? size + 3;
    const maxChars = Math.max(1, Math.floor(widthChars / (size * 0.6)));
    for (const part of splitToWidth(text, maxChars)) {
      this.push([{ text: part, x: MARGIN, bold: options.bold, size }], size, gap);
    }
  }

  row(runs: TextRun[], size = 9): void {
    this.push(runs, size, size + 4);
  }

  spacer(height: number): void {
    this.ensureSpace(height);
    this.y += height;
  }

  get pageRows(): PdfRow[] {
    return this.rows;
  }

  get breaks(): number[] {
    return this.pageBreaks;
  }
}

function columns(
  values: string[],
  widths: number[],
  alignRight: boolean[],
  size: number,
): TextRun[] {
  let x = MARGIN;
  const runs: TextRun[] = [];
  values.forEach((value, index) => {
    const width = widths[index]!;
    const text = latin1(value);
    const maxChars = Math.max(1, Math.floor(width / (size * 0.6)));
    const truncated = text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
    const textWidth = truncated.length * size * 0.6;
    const startX = alignRight[index] ? x + width - textWidth : x;
    runs.push({ text: truncated, x: Math.max(MARGIN, startX), size });
    x += width;
  });
  return runs;
}

function renderPages(rows: PdfRow[], breaks: number[]): Buffer {
  const pageBounds: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (const breakAt of breaks) {
    pageBounds.push({ from, to: breakAt });
    from = breakAt;
  }
  pageBounds.push({ from, to: rows.length });

  const pageCount = pageBounds.length;
  const contentNumbers: number[] = [];
  const pageNumbers: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    contentNumbers.push(3 + index * 2);
    pageNumbers.push(4 + index * 2);
  }
  const font1Number = 3 + pageCount * 2;
  const font2Number = font1Number + 1;
  const objectCount = font2Number;

  const bodies = new Array<string>(objectCount + 1);
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${pageNumbers.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pageBounds.forEach((bound, index) => {
    const operations: string[] = [];
    for (let rowIndex = bound.from; rowIndex < bound.to; rowIndex += 1) {
      const row = rows[rowIndex]!;
      for (const run of row.runs) {
        const size = run.size ?? 9;
        const baseline = PAGE_HEIGHT - (row.top + size * 0.8);
        const font = run.bold ? '/F2' : '/F1';
        operations.push(
          `BT ${font} ${size.toFixed(2)} Tf 1 0 0 1 ${run.x.toFixed(2)} ${baseline.toFixed(2)} Tm (${escapePdfText(run.text)}) Tj ET`,
        );
      }
    }
    const content = operations.join('\n');
    bodies[contentNumbers[index]!] =
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
    bodies[pageNumbers[index]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${font1Number} 0 R /F2 ${font2Number} 0 R >> >> ` +
      `/Contents ${contentNumbers[index]} 0 R >>`;
  });
  bodies[font1Number] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  bodies[font2Number] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.from(`${objectNumber} 0 obj\n${bodies[objectNumber]}\nendobj\n`, 'latin1'));
  }
  const xrefOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  let xref = `xref\n0 ${objectCount + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1',
    ),
  );
  return Buffer.concat(chunks);
}

function money(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(String(value ?? 0));
  if (!Number.isFinite(number)) return '0.00';
  return new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Renders an issued invoice from its DB snapshot. `invoice.lines` must carry
 * the stored line snapshot fields. Output is deterministic.
 */
export function renderInvoicePdf(invoice: any): Buffer {
  const layout = new PdfLayout();
  const number = text(invoice.invoice_number);
  const isCredit = Boolean(invoice.credit_of_invoice_id);
  const title = isCredit ? `CREDIT NOTE ${number}` : `INVOICE ${number}`;
  const sellerName = text(invoice.seller_legal_name) || 'Tilivo';
  const customer = invoice.customer_snapshot && typeof invoice.customer_snapshot === 'object'
    ? invoice.customer_snapshot
    : {};

  layout.line('Tilivo', { bold: true, size: 16, gap: 20 });
  layout.wrap(sellerName, 100, { size: 11 });
  if (text(invoice.seller_business_id)) {
    layout.line(`Business ID: ${text(invoice.seller_business_id)}`, { size: 9, gap: 11 });
  }
  layout.spacer(8);
  layout.line(title, { bold: true, size: 13, gap: 18 });
  layout.line(`Issued: ${text(invoice.issue_date)}`, { size: 10 });
  layout.line(`Due: ${text(invoice.due_date)}`, { size: 10 });
  layout.line(`Invoice number: ${number}`, { size: 10 });
  if (invoice.payment_reference) {
    layout.line(`Payment reference: ${invoice.payment_reference}`, { size: 10 });
  }
  layout.line(`Currency: ${text(invoice.currency_code)}`, { size: 10 });
  layout.spacer(10);

  layout.line('Bill to', { bold: true, size: 10 });
  layout.wrap(text(customer.name), 78, { size: 10 });
  if (text(customer.business_id)) {
    layout.line(`Business ID: ${text(customer.business_id)}`, { size: 9, gap: 11 });
  }
  if (text(customer.vat_id)) {
    layout.line(`VAT ID: ${text(customer.vat_id)}`, { size: 9, gap: 11 });
  }
  layout.wrap(
    [text(customer.address_line1), text(customer.address_line2)].filter((part) => part).join(', '),
    78,
    { size: 9 },
  );
  layout.wrap(
    [text(customer.postal_code), text(customer.city)].filter((part) => part).join(' '),
    78,
    { size: 9 },
  );
  if (text(customer.country_code)) {
    layout.line(text(customer.country_code), { size: 9, gap: 11 });
  }
  layout.spacer(16);

  const widths = [190, 58, 65, 60, 80, 100];
  const headers = ['Description', 'Qty', 'Unit price', 'VAT %', 'Net', 'Total'];
  layout.row(columns(headers, widths, [false, true, true, true, true, true], 9).map((run) => ({ ...run, bold: true })));
  layout.line('-'.repeat(92), { size: 9, gap: 11 });

  const lines: any[] = Array.isArray(invoice.lines) ? invoice.lines : [];
  const descChars = Math.max(12, Math.floor(widths[0]! / (9 * 0.6)));
  for (const line of lines) {
    const description = text(line.description);
    const descParts = splitToWidth(description, descChars);
    descParts.forEach((part, partIndex) => {
      const quantity = text(line.unit)
        ? `${text(line.quantity)} ${text(line.unit)}`
        : text(line.quantity);
      const cells = [
        part,
        partIndex === 0 ? quantity : '',
        partIndex === 0 ? money(line.unit_price) : '',
        partIndex === 0 ? text(line.tax_rate_snapshot) : '',
        partIndex === 0 ? money(line.net_amount) : '',
        partIndex === 0 ? money(line.gross_amount) : '',
      ];
      layout.row(columns(cells, widths, [false, true, true, true, true, true], 9));
    });
  }
  layout.line('-'.repeat(92), { size: 9, gap: 12 });
  layout.spacer(12);

  const totalRows: Array<[string, unknown, boolean]> = [
    ['Subtotal', invoice.subtotal, false],
    ['VAT total', invoice.tax_total, false],
    ['Total', invoice.total, true],
  ];
  for (const [label, value, bold] of totalRows) {
    const labelWidth = 120;
    const amountWidth = 170;
    const leftX = PAGE_WIDTH - MARGIN - labelWidth - amountWidth - 20;
    const amountX = PAGE_WIDTH - MARGIN - amountWidth;
    layout.row([
      { text: String(label), x: leftX, size: 10, bold },
      { text: money(value), x: amountX, size: 10, bold },
    ]);
  }

  // VAT summary by tax code/rate (snapshot fields, deterministic).
  const breakdown = new Map<string, { rate: string; net: Decimal; tax: Decimal }>();
  for (const line of lines) {
    const rate = text(line.tax_rate_snapshot);
    const code = text(line.tax_code_snapshot) || text(line.tax_treatment_snapshot) || `rate ${rate}`;
    if (!rate && !code) continue;
    const key = `${code}|${rate}`;
    const current = breakdown.get(key) ?? { rate, net: new Decimal(0), tax: new Decimal(0) };
    current.net = current.net.plus(new Decimal(String(line.net_amount ?? '0')));
    current.tax = current.tax.plus(new Decimal(String(line.tax_amount ?? '0')));
    breakdown.set(key, current);
  }
  if (breakdown.size > 0) {
    layout.spacer(10);
    layout.line('Tax summary', { bold: true, size: 10 });
    for (const [key, group] of breakdown) {
      const label = `${key}${group.rate ? ` ${group.rate}%` : ''}`;
      layout.line(
        `${label}: net ${money(group.net)} / VAT ${money(group.tax)}`,
        { size: 8, gap: 11 },
      );
    }
  }

  const legalNotes: string[] = [
    ...new Set(
      lines
        .map((line: any): string =>
          line.tax_legal_note
            ? fillLegalNote(String(line.tax_legal_note), {
                businessId: text(customer.business_id) || null,
                vatId: text(customer.vat_id) || null,
              })
            : '',
        )
        .filter((note): note is string => Boolean(note)),
    ),
  ];
  if (legalNotes.length > 0) {
    layout.spacer(10);
    layout.line('Tax notes', { bold: true, size: 10 });
    for (const note of legalNotes) {
      layout.wrap(note, 94, { size: 8, gap: 11 });
    }
  }

  layout.spacer(18);
  layout.line('Thank you for your business.', { size: 9 });
  layout.line(
    `Document generated by Tilivo. Currency amounts in ${text(invoice.currency_code)}.`,
    { size: 8, gap: 11 },
  );
  return renderPages(layout.pageRows, layout.breaks);
}

export function pdfSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
