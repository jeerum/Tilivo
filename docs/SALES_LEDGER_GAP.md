# v0.12 Sales Ledger 2.0 — gap analysis

## Existing

- Sales invoices with draft -> issued -> credited lifecycle, tenant-scoped
  numbering series, customer snapshots, payment references, deterministic
  PDF, VAT engine lines, Accounting Core posting, full credit notes,
  permissions, audit, desktop/mobile Sales UI.

## Partial

- Payment state exists only via CREDITED; no UNPAID/PAID/partial tracking.
- Full credit note only; no partial credit/advance/recurring documents.
- Invoice list has no AR columns (paid/open/overdue) or AR summary.

## Missing

- Document types (ADVANCE_INVOICE, recurring), payment/reminder tables,
  recurring templates, AR ledger/summary endpoints, aging, late-interest
  readiness columns, reminder workflow, bank detail config on sales
  settings.

## Implemented (this version)

- Sales document type model, payment status/amount, AR ledger view and
  summary, manual payment records (non-bank), reminders + history,
  recurring monthly/quarterly/yearly templates with deterministic draft
  generation and idempotency, customer PO/reference fields, bank-detail
  settings columns.

## v0.12 completion (2026-09-03, uncommitted gate work)

- Partial credit notes (multiple per invoice, line/quantity caps, over-credit
  rejection, full-remaining transition) with `SALES_INVOICE.PARTIALLY_CREDITED`.
- Advance invoices: issued as Dr AR / Cr advances-received (no revenue, no
  VAT); final invoices allocate advances (Dr advances received + Dr AR
  remaining / Cr revenue + VAT) with idempotent application rows and audit.
- Invoice-level discounts (percent or fixed) allocated to lines before VAT
  deterministically; frozen at issue and shown on the PDF.
- PDF: FI/EN/ET labels independent of UI language, distinct titles for
  invoice/credit note/advance/reminder, tenant bank details, discounts,
  advance/credit applied, VAT summary and legal notes.
- Reminders: configurable fee + late-interest readiness, PDF output and
  e-mail send via the provider abstraction; send history never marks failures
  as sent.
- AR aging (not due, 1-7, 8-30, 31-60, 61-90, 90+), customer statement with
  running balance and customer-level totals (invoiced/paid/credited/open).
- Delivery methods (EMAIL/E_INVOICE/PDF_MANUAL/OTHER) and e-invoice readiness
  export with a `document_send_history` trail.
- Official Finnish sources (checked 2026-09-03): vero.fi 30.5.2024 press
  release (advance VAT chargeable on receipt of payment) and Bank of Finland
  reference/penalty rate release of 29.6.2026 (Interest Act 4/4 a §).

## v0.12 feature gate closure (2026-09-03)

Browser UI now exposes customer invoice language and delivery/e-invoice
defaults, issued-invoice advance state, payments, partial/full credits,
advance allocation, reminders with PDF/send, e-mail/e-invoice delivery,
AR aging, customer statement and recurring management. v0.12 browser E2E:
15/15 PASS on desktop/tablet/mobile, 0 skipped. Combined legacy Playwright
stress runs are documented separately as "E2E Test Isolation Hardening".

## Boundary with v0.13

Payments are manual AR readiness records; they do not post bank journal
entries. Banking module will own payment/bank reconciliation later.
