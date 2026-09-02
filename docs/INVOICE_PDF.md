# Invoice PDF

PDF genereeritakse serveris brauserivabalt ja deterministlikult
(`src/services/invoicePdf.ts`), kasutades PDF 1.4 + Courier core-fonte.
Sama sisend annab alati samad baidid, mistõttu SHA-256 on stabiilne.

## Voog

```text
ISSUE commit
  -> integration_outbox SALES_INVOICE_PDF_REQUESTED
  -> tilivo-worker render + salvestus
  -> sales_invoice_pdfs READY + document/document_version metadata
```

- Väljund salvestatakse object storage'sse (`LocalObjectStorageProvider`)
  võtmega `{tenant}/{invoice}/{uuid}.pdf`.
- `sha256`, `size_bytes`, `document_id` salvestatakse PDF-real.
- PDF lüüakse alla ainult `GET /api/v1/sales/invoices/:id/pdf` kaudu, mis
  nõuab sessiooni ja tenandiõigust; avalikku kausta pole.
- `Content-Disposition` kasutab ohutut failinime.

## Worker

- `processPdfRequest` lukustab PDF-rea `FOR UPDATE`; duplikaat-job on no-op.
- RLS rakendub workerile (tenant context seades); worker näeb ainult oma
  tenandi arveandmeid.
- Töötlemisviga märgib PDF-rea `FAILED` ja outbox läheb tagasi
  eksponentsiaalse tagasiprooviga.

Vt ADR-0018.
