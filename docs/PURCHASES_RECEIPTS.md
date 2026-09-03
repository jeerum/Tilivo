# Purchases & Receipts (v0.10)

## Purchase documents

The existing `purchase_invoices` table is the unified purchase-document
model:

- `document_type`: `PURCHASE_INVOICE`, `RECEIPT`, `CREDIT_NOTE`,
  `CASH_EXPENSE`, `CARD_EXPENSE`
- `payment_method`: `BANK_TRANSFER`, `COMPANY_CARD`, `CASH`,
  `PERSONAL_CARD`, `EMPLOYEE_PAID`, `OTHER`
- `payment_status`: `UNPAID`, `PAID`, `PARTIALLY_PAID`, `PAID_AT_PURCHASE`
- `merchant_name` for ad-hoc receipts without a supplier master record
- `ocr_status`: `NOT_REQUESTED`, `QUEUED`, `PROCESSING`, `COMPLETE`,
  `FAILED`; `ocr_provider` and `ocr_error`
- `duplicate_warning` surfaced in the UI

Credit notes/corrections continue through the existing
`purchase_invoice_corrections` reversal architecture; nothing new was built
for that path.

## Receipt workflow

1. Add receipt (desktop/mobile button; camera/gallery/file supported through
   the file input with `accept="image/*,application/pdf"`).
2. Draft is created through `/api/v1/purchases` with `document_type=RECEIPT`.
3. Source file uploads through existing
   `POST /api/v1/purchases/:id/documents` (PDF/JPEG/PNG; SHA-256 stored).
4. `POST /api/v1/purchases/:id/ocr` runs the OCR provider, stores immutable
   extractions, fills draft lines/fields, matches an unambiguous supplier,
   and refreshes duplicate warnings.
5. User reviews/edits, then existing review -> approve -> post lifecycle.

## OCR abstraction

- `DocumentOcrProvider` interface returns a normalized `OcrResult`.
- `MockDocumentOcrProvider` is deterministic and used in dev/tests;
  `OCR_DRIVER=mock` is the default. No CI dependency on live OCR.
- OCR failure preserves the uploaded document and marks the draft
  `FAILED`; retry is safe (no duplicate document).
- Extracted fields/confidence stay in `purchase_invoice_extractions` for
  later v0.11 AI classification.

## Supplier matching

OCR results match existing suppliers by Business ID, VAT number, or exact
normalized name. Only a single unambiguous candidate is linked; ambiguous
candidates remain unlinked for manual choice. Merchant-only receipts do not
require a supplier master record.

## Duplicate detection

Exact SHA-256 file duplicates are reported as the strongest signal; supplier
+ date + total heuristics produce a softer warning. Warnings never block
valid duplicates.

## Accounting integration

All documents post through Accounting Core + VAT engine:

- `BANK_TRANSFER` unpaid invoice -> Accounts Payable
- `CASH` -> configured cash account
- `COMPANY_CARD` -> configured card-clearing account
- `PERSONAL_CARD` / `EMPLOYEE_PAID` -> employee/owner payable

`purchase_settings` now carries `cash_account_id`,
`company_card_account_id` and `employee_payable_account_id`. Posting remains
immutable, period-locked and idempotent; journal metadata retains source
links (`PURCHASE_INVOICE` source type + document id).

## Permissions

Existing purchase permissions remain; `Employee` may now create drafts and
upload documents (`purchase.create`, `purchase.document.upload`) while
classification/post permissions stay with Owner/Admin/Accountant.

## Mobile / desktop

Purchases gained a Receipts tab (`/purchases` -> Receipts). The mobile flow
uses the same controls at 390 px: Add receipt, form, file/camera upload,
OCR, review/approve/post. Tables scroll; no hover-only actions.

## Security

Uploads reuse the existing document storage provider (tenant isolation,
path-traversal guard, MIME/signature validation, 10 MB limit, SHA-256, safe
download). No new storage infrastructure.

## Tests

- Unit: payment counter-account mapping, OCR fixture normalization,
  malformed OCR, multi-rate VAT, partial deductibility.
- Integration: upload/OCR lifecycle, OCR failure fallback, supplier
  matching/ambiguity, cash/card/employee posting, multi-rate OCR,
  duplicate heuristic + exact hash, posting immutability/period lock/audit.
- Browser E2E desktop/tablet/mobile Receipts flow.

## Known limitations

- OCR provider is a deterministic mock; live OCR can be added behind the
  same interface without changing callers.
- Foreign-currency receipts preserve original currency/amount but full FX
  conversion remains out of scope.
- Payment initiation/bank reconciliation intentionally not implemented.
