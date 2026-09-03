# Tilivo Purchases (v0.7)

Ostuarvete moodul loeb sisse tarnija arveid (PDF/pilt/manuaalne/XML),
juhendab need ülevaatuse ja kinnitamise kaudu pearaamatupostitusse ning hoiab
postitatud ajaloo muutumatuna.

## Ulatus

- Supplier kasutab v0.6 `business_parties` mudelit (`is_supplier`).
- `purchase_invoices` / `purchase_invoice_lines` elutsükliga
  INGESTED -> NEEDS_REVIEW -> READY_FOR_APPROVAL -> APPROVED -> POSTED.
- `purchase_invoice_documents`, `purchase_invoice_approvals`,
  `purchase_invoice_extractions`, `purchase_invoice_corrections`,
  `purchase_imports` ja `purchase_settings`.
- E-arve adapterid: Finvoice, PEPPOL BIS ja TEAPPSXML -> canonical model.
- OCR provider on Noop foundation; manual review ei vaja OCR-i.

## API

```text
GET/POST/PATCH /api/v1/suppliers
GET           /api/v1/suppliers/:id
GET/PATCH     /api/v1/purchase-settings

GET/POST      /api/v1/purchases
GET/PATCH     /api/v1/purchases/:id
POST          /api/v1/purchases/:id/review|approve|post|reject|correct|cancel-draft
POST          /api/v1/purchases/import
GET           /api/v1/purchases/inbox
GET/POST      /api/v1/purchases/:id/documents
```

Detailid:

- [PURCHASE_LIFECYCLE.md](PURCHASE_LIFECYCLE.md)
- [PURCHASE_INGESTION.md](PURCHASE_INGESTION.md)
- [EINVOICE_ADAPTERS.md](EINVOICE_ADAPTERS.md)
- [PURCHASE_APPROVAL.md](PURCHASE_APPROVAL.md)
- [PURCHASE_ACCOUNTING.md](PURCHASE_ACCOUNTING.md)
- [OCR_EXTRACTION.md](OCR_EXTRACTION.md)
