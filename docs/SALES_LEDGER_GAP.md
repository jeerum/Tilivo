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

## Boundary with v0.13

Payments are manual AR readiness records; they do not post bank journal
entries. Banking module will own payment/bank reconciliation later.
