# v0.10 Purchases & Receipts — gap analysis

Audit date: 2026-09-03, after pre-v0.10 commit `ffa99d1`.

## Existing

- Purchase invoices, lines, suppliers, approvals, extractions, corrections,
  imports and settings (`20260904000000_purchases_core`), RLS + FORCE,
  composite tenant FKs, immutability triggers.
- Full lifecycle: INGESTED/DRAFT -> NEEDS_REVIEW -> READY_FOR_APPROVAL ->
  APPROVED -> POSTED; reject, cancel, correction reversal.
- Secure upload of PDF/JPEG/PNG via existing document/object storage
  (`purchase_invoice_documents`, SHA-256 document versions), list/download
  endpoints, upload permission `purchase.document.upload`.
- Supplier matching by Business ID/VAT/e-invoice address/IBAN/name with
  ambiguity handling; e-invoice canonical import and duplicate external key.
- v0.9 VAT engine on every line, deductibility, semantic codes, partial
  deductibility, RC/EU handling.
- Audit hash-chain events for purchase lifecycle and uploads.

## Partial

- Receipt concept: purchases are treated as invoices only; no document type.
- OCR: `purchase_invoice_extractions` exists and is immutable, but there is
  no OCR provider/service/state and no extraction-driven review flow.
- Payment handling: invoices always post to Accounts Payable; no explicit
  payment method/status; cash/card/employee-paid accounting unavailable.
- Attachments: upload requires an existing draft; no receipt-first capture
  flow, no camera UX, no preview controls, no duplicate file-hash warnings.
- Expense account selection exists per line but the UI is account-only and
  not category/merchant-driven.

## Missing

- Document type model (RECEIPT/CASH_EXPENSE/CARD_EXPENSE/CREDIT_NOTE on the
  shared purchase workflow).
- Payment method + payment status fields and payment-aware counter-accounts
  (cash, company-card clearing, employee/owner payable).
- OCR provider abstraction, deterministic local/mock provider, OCR state and
  retry without document duplication.
- Receipt workflow: Add receipt (camera/gallery/file), OCR review, supplier
  match suggestion, account/tax/payment selectors, save/post.
- Duplicate detection: exact SHA-256 and heuristic warnings surfaced in UI.
- Simple deterministic suggestions (previous supplier -> last account/tax).
- Receipt previews/rotation and mobile-first capture.

## Needs refactor

- Purchase service/route extension points should grow on the existing draft
  lifecycle instead of introducing a second subsystem.

## Implementation direction

Reuse `purchase_invoices` as the unified purchase-document table, add
`document_type`, `payment_method`, `payment_status`, `ocr_status`, merchant
description and duplicate-warning columns. Add payment counter-account
mappings to `purchase_settings`. Add `DocumentOcrProvider` abstraction with a
deterministic mock/local provider and keep `purchase_invoice_extractions` as
the immutable extracted-signal store. All posting continues through the
Accounting Core and VAT engine.
