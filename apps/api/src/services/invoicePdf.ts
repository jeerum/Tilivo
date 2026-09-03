import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { fillLegalNote } from './vatEngineService';
import { pdfLabel, pdfLabelsFor, pdfTitle, type PdfLabelKey } from './invoicePdfLabels';
import { normalizeSalesLanguage } from './salesMath';

/**
 * Deterministic, browser-free PDF rendering for issued sales documents and
 * reminders. Writes a minimal PDF 1.4 document using Courier core fonts with
 * Windows-1252 text encoding (ä ö ü õ š ž supported). The same input always
 * produces the same bytes, keeping SHA-256 storage checks stable.
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

/**
 * Maps JS code points to Windows-1252 single bytes. cp1252 covers the Nordic
 * and Baltic characters used in fi/et/en invoice labels plus typographic
 * punctuation; anything unknown falls back to '?'.
 */
function win1252Bytes(text: string): number[] {
  const cp1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code <= 0xff) {
      bytes.push(code);
    } else if (cp1252[code] !== undefined) {
      bytes.push(cp1252[code]!);
    } else {
      bytes.push(0x3f); // '?'
    }
  }
  return bytes;
}

function win1252(text: string): string {
  return Buffer.from(win1252Bytes(text)).toString('latin1');
}

function escapePdfText(text: string): string {
  const escaped: string[] = [];
  for (const character of win1252(text)) {
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
  const clean = win1252(text).replace(/\s+/g, ' ').trim();
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
    this.push([{ text: win1252(text), x: MARGIN, bold: options.bold, size }], size, options.gap ?? size + 3);
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

  /** A right-aligned label/value pair (used for totals and payment box). */
  kv(label: string, value: string, options: { bold?: boolean; size?: number; gap?: number } = {}): void {
    const size = options.size ?? 10;
    const labelWidth = 200;
    const amountWidth = 150;
    const gap = options.gap ?? size + 5;
    const leftX = PAGE_WIDTH - MARGIN - labelWidth - amountWidth - 20;
    const amountX = PAGE_WIDTH - MARGIN - amountWidth;
    this.push(
      [
        { text: win1252(label), x: leftX, size, bold: options.bold },
        { text: win1252(value), x: amountX, size, bold: options.bold },
      ],
      size,
      gap,
    );
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
    const text = win1252(value);
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

function lineTotal(value: Decimal | string): string {
  return new Decimal(value).toFixed(2);
}

function detectKind(invoice: any): 'CREDIT_NOTE' | 'ADVANCE_INVOICE' | 'INVOICE' {
  const documentType = String(invoice.document_type ?? '');
  if (documentType === 'ADVANCE_INVOICE') return 'ADVANCE_INVOICE';
  if (Boolean(invoice.credit_of_invoice_id) || documentType === 'SALES_CREDIT_NOTE') return 'CREDIT_NOTE';
  return 'INVOICE';
}

type LabelSet = ReturnType<typeof pdfLabelsFor>;

function renderSellerAndCustomer(layout: PdfLayout, invoice: any, labels: LabelSet, kind: string): void {
  const number = text(invoice.invoice_number);
  const sellerName = text(invoice.seller_legal_name) || 'Tilivo';
  const customer = invoice.customer_snapshot && typeof invoice.customer_snapshot === 'object'
    ? invoice.customer_snapshot
    : {};

  layout.line('Tilivo', { bold: true, size: 16, gap: 20 });
  layout.wrap(sellerName, 100, { size: 11 });
  if (text(invoice.seller_business_id)) {
    layout.line(`${labels.businessId}: ${text(invoice.seller_business_id)}`, { size: 9, gap: 11 });
  }
  layout.spacer(8);
  layout.line(`${pdfTitle(kind as any, invoice.language)} ${number}`, { bold: true, size: 13, gap: 18 });
  layout.line(`${labels.invoiceDate}: ${text(invoice.issue_date)}`, { size: 10 });
  layout.line(`${labels.dueDate}: ${text(invoice.due_date)}`, { size: 10 });
  layout.line(`${labels.invoiceNumber}: ${number}`, { size: 10 });
  if (invoice.payment_reference) {
    layout.line(`${labels.paymentReference}: ${invoice.payment_reference}`, { size: 10 });
  }
  layout.line(`${labels.currency}: ${text(invoice.currency_code)}`, { size: 10 });
  if (invoice.customer_po_number) {
    layout.line(`PO: ${text(invoice.customer_po_number)}`, { size: 9, gap: 11 });
  }
  layout.spacer(10);

  layout.line(labels.billTo, { bold: true, size: 10 });
  layout.wrap(text(customer.name), 78, { size: 10 });
  if (text(customer.business_id)) {
    layout.line(`${labels.businessId}: ${text(customer.business_id)}`, { size: 9, gap: 11 });
  }
  if (text(customer.vat_id)) {
    layout.line(`${labels.vatId}: ${text(customer.vat_id)}`, { size: 9, gap: 11 });
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
  if (text(customer.email)) {
    layout.line(text(customer.email), { size: 9, gap: 11 });
  }
  layout.spacer(16);
}

function renderLines(layout: PdfLayout, invoice: any, labels: LabelSet): void {
  const widths = [150, 60, 68, 40, 46, 56, 80];
  const headers = [
    labels.description,
    labels.quantity,
    labels.unitPrice,
    labels.discount,
    labels.vat,
    labels.net,
    labels.total,
  ];
  layout.row(columns(headers, widths, [false, true, true, true, true, true, true], 9).map((run) => ({ ...run, bold: true })));
  layout.line('-'.repeat(105), { size: 9, gap: 11 });

  const lines: any[] = Array.isArray(invoice.lines) ? invoice.lines : [];
  const descChars = Math.max(10, Math.floor(widths[0]! / (9 * 0.6)));
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
        partIndex === 0 ? (Number(line.discount_percent ?? 0) > 0 ? `${text(line.discount_percent)}%` : '') : '',
        partIndex === 0 ? text(line.tax_rate_snapshot) : '',
        partIndex === 0 ? money(line.net_amount) : '',
        partIndex === 0 ? money(line.gross_amount) : '',
      ];
      layout.row(columns(cells, widths, [false, true, true, true, true, true, true], 9));
    });
  }
  layout.line('-'.repeat(105), { size: 9, gap: 12 });
  layout.spacer(10);
}

function renderTotals(layout: PdfLayout, invoice: any, labels: LabelSet): void {
  const subtotal = new Decimal(String(invoice.subtotal ?? '0'));
  const discount = new Decimal(String(invoice.discount_amount ?? '0'));
  const tax = new Decimal(String(invoice.tax_total ?? '0'));
  const total = new Decimal(String(invoice.total ?? '0'));
  const credited = new Decimal(String(invoice.credited_amount ?? '0'));
  const paid = new Decimal(String(invoice.amount_paid ?? '0'));
  const advanceApplied = new Decimal(String(invoice.advance_applied ?? '0'));

  layout.kv(`${labels.net}:`, lineTotal(subtotal));
  if (discount.greaterThan(0)) {
    layout.kv(
      `${labels.discount}${Number(invoice.discount_percent ?? 0) > 0 ? ` (${text(invoice.discount_percent)}%)` : ''}:`,
      `-${lineTotal(discount)}`,
    );
  }
  layout.kv(`${labels.vatTotal}:`, lineTotal(tax));
  layout.kv(`${labels.total}:`, lineTotal(total), { bold: true, gap: 12 });
  if (advanceApplied.greaterThan(0)) {
    layout.kv(`${labels.advanceApplied}:`, `-${lineTotal(advanceApplied)}`, { size: 9 });
    layout.kv(
      `${labels.amountDue}:`,
      lineTotal(total.minus(advanceApplied)),
      { bold: true, size: 11, gap: 14 },
    );
  }
  if (credited.greaterThan(0) || (invoice.credit_of_invoice_id && total.greaterThan(0))) {
    const creditValue = invoice.credit_of_invoice_id ? total : credited;
    layout.kv(`${labels.creditApplied}:`, `-${lineTotal(creditValue)}`, { size: 9 });
  }
  if (paid.greaterThan(0)) {
    layout.kv(`${labels.amountPaid}:`, `-${lineTotal(paid)}`, { size: 9 });
    const open = total.minus(advanceApplied).minus(credited).minus(paid);
    layout.kv(`${labels.openBalance}:`, lineTotal(open.greaterThan(0) ? open : new Decimal(0)), { bold: true, size: 10, gap: 14 });
  }
}

function renderTaxSummary(layout: PdfLayout, invoice: any, labels: LabelSet): void {
  const lines: any[] = Array.isArray(invoice.lines) ? invoice.lines : [];
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
    layout.line(labels.taxSummary, { bold: true, size: 10 });
    for (const [key, group] of breakdown) {
      const label = `${key}${group.rate ? ` ${group.rate}%` : ''}`;
      layout.line(
        `${label}: ${labels.net} ${money(group.net)} / ${labels.vat} ${money(group.tax)}`,
        { size: 8, gap: 11 },
      );
    }
  }

  const customer = invoice.customer_snapshot && typeof invoice.customer_snapshot === 'object'
    ? invoice.customer_snapshot
    : {};
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
    layout.line(labels.taxNotes, { bold: true, size: 10 });
    for (const note of legalNotes) {
      layout.wrap(note, 100, { size: 8, gap: 11 });
    }
  }
}

function renderPaymentDetails(layout: PdfLayout, invoice: any, labels: LabelSet): void {
  const iban = text(invoice.bank_iban);
  const bic = text(invoice.bank_bic);
  const holder = text(invoice.bank_account_holder);
  if (!iban && !bic && !holder) return;
  layout.spacer(12);
  layout.line('-'.repeat(105), { size: 9, gap: 12 });
  layout.line(labels.amountDue.toUpperCase(), { bold: true, size: 10, gap: 12 });
  if (holder) layout.kv(`${labels.accountHolder}:`, holder, { size: 9 });
  if (iban) layout.kv(`${labels.iban}:`, iban, { size: 9, bold: true });
  if (bic) layout.kv(`${labels.bic}:`, bic, { size: 9 });
  if (invoice.payment_reference) {
    layout.kv(`${labels.paymentReference}:`, text(invoice.payment_reference), { size: 9 });
  }
  layout.kv(`${labels.dueDate}:`, text(invoice.due_date), { size: 9 });
  const advanceApplied = new Decimal(String(invoice.advance_applied ?? '0'));
  const amountDue = new Decimal(String(invoice.total ?? '0')).minus(advanceApplied);
  layout.kv(`${labels.amountDue}:`, lineTotal(amountDue), { bold: true, size: 11, gap: 14 });
}

/**
 * Renders an issued invoice/credit note/advance invoice from its DB snapshot.
 * `invoice.lines` must carry the stored line snapshot fields and
 * `invoice.language` selects the PDF labels (frozen at issue). Output is
 * deterministic.
 */
export function renderInvoicePdf(invoice: any): Buffer {
  const layout = new PdfLayout();
  const kind = detectKind(invoice);
  const labels = pdfLabelsFor(invoice.language ?? 'en');
  renderSellerAndCustomer(layout, invoice, labels, kind);
  renderLines(layout, invoice, labels);
  renderTotals(layout, invoice, labels);
  renderTaxSummary(layout, invoice, labels);
  renderPaymentDetails(layout, invoice, labels);

  layout.spacer(14);
  layout.line(labels.thankYou, { size: 9 });
  layout.line(
    `${labels.footer} ${labels.currency}: ${text(invoice.currency_code)}.`,
    { size: 8, gap: 11 },
  );
  return renderPages(layout.pageRows, layout.breaks);
}

export interface ReminderPdfInput {
  invoice: any;
  reminder: any;
}

/** Renders a printable reminder document. */
export function renderReminderPdf(input: ReminderPdfInput): Buffer {
  const layout = new PdfLayout();
  const { invoice, reminder } = input;
  const labels = pdfLabelsFor(reminder.language ?? invoice.language ?? 'en');
  const number = text(reminder.reminder_number);
  const invoiceNumber = text(invoice.invoice_number);
  const customer = invoice.customer_snapshot && typeof invoice.customer_snapshot === 'object'
    ? invoice.customer_snapshot
    : {};
  const sellerName = text(invoice.seller_legal_name) || 'Tilivo';

  layout.line('Tilivo', { bold: true, size: 16, gap: 20 });
  layout.wrap(sellerName, 100, { size: 11 });
  layout.spacer(8);
  layout.line(`${pdfTitle('REMINDER', reminder.language)} ${number}`, { bold: true, size: 13, gap: 18 });
  layout.line(`${labels.reminderDate}: ${toDateText(reminder.created_at ?? reminder.reminder_date)}`, { size: 10 });
  layout.line(`${labels.originalInvoice}: ${invoiceNumber}`, { size: 10 });
  layout.line(`${labels.originalDueDate}: ${text(invoice.due_date)}`, { size: 10 });
  if (invoice.payment_reference) {
    layout.line(`${labels.paymentReference}: ${text(invoice.payment_reference)}`, { size: 10 });
  }
  layout.spacer(10);

  layout.line(labels.customer, { bold: true, size: 10 });
  layout.wrap(text(customer.name), 78, { size: 10 });
  if (text(customer.business_id)) {
    layout.line(`${labels.businessId}: ${text(customer.business_id)}`, { size: 9, gap: 11 });
  }
  layout.spacer(16);

  layout.kv(`${labels.amountDue}:`, money(reminder.amount_due), { bold: true });
  if (Number(reminder.fee_amount ?? 0) > 0) {
    layout.kv(`${labels.reminderFee}:`, money(reminder.fee_amount));
  }
  if (Number(reminder.interest_amount ?? 0) > 0) {
    layout.kv(
      `${labels.lateInterest} (${text(reminder.interest_rate)}%, ${text(reminder.interest_days)} ${labels.interestDays.toLowerCase()}):`,
      money(reminder.interest_amount),
    );
  }
  const totalDue = new Decimal(String(reminder.amount_due ?? '0'))
    .plus(new Decimal(String(reminder.fee_amount ?? '0')))
    .plus(new Decimal(String(reminder.interest_amount ?? '0')));
  layout.kv(`${labels.total}:`, money(totalDue), { bold: true, size: 11, gap: 14 });

  if (text(reminder.note)) {
    layout.spacer(8);
    layout.line(`${labels.message}:`, { bold: true, size: 10 });
    layout.wrap(text(reminder.note), 100, { size: 9 });
  }

  layout.spacer(12);
  layout.line('-'.repeat(105), { size: 9, gap: 12 });
  layout.line(labels.amountDue.toUpperCase(), { bold: true, size: 10, gap: 12 });
  if (text(invoice.bank_account_holder)) {
    layout.kv(`${labels.accountHolder}:`, text(invoice.bank_account_holder), { size: 9 });
  }
  if (text(invoice.bank_iban)) {
    layout.kv(`${labels.iban}:`, text(invoice.bank_iban), { size: 9, bold: true });
  }
  if (text(invoice.bank_bic)) {
    layout.kv(`${labels.bic}:`, text(invoice.bank_bic), { size: 9 });
  }
  if (invoice.payment_reference) {
    layout.kv(`${labels.paymentReference}:`, text(invoice.payment_reference), { size: 9 });
  }
  layout.kv(`${labels.dueDate}:`, text(invoice.due_date), { size: 9 });
  layout.kv(`${labels.amountDue}:`, money(totalDue), { bold: true, size: 11, gap: 14 });

  layout.spacer(14);
  layout.line(labels.thankYou, { size: 9 });
  layout.line(labels.footer, { size: 8, gap: 11 });
  return renderPages(layout.pageRows, layout.breaks);
}

function toDateText(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = String(value ?? '');
  return raw.slice(0, 10);
}

export function pdfSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Exposed for tests; normalizes the frozen invoice language. */
export function renderInvoiceLanguage(invoice: any): string {
  return normalizeSalesLanguage(invoice.language);
}

export type { PdfLabelKey };
export { pdfLabel };
