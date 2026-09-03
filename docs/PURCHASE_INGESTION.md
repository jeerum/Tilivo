# Purchase ingestion

Sisendid:

- MANUAL – kasutaja sisestab arve.
- UPLOAD_PDF / UPLOAD_IMAGE – dokument lingitakse `purchase_invoice_documents`;
  OCR provider on Noop foundation, ekstraheerimisandmeid pole (OCR-001).
- FINVOICE / PEPPOL / TEAPPSXML – turvaline XML-parser -> canonical model ->
  `NEEDS_REVIEW` ostuarve + extraction read (STRUCTURED_XML, confidence 1).
- API – sama import-voog.
- EMAIL – tulevase mailbox-ingestioni adapterikoht; Postfixit ei muudeta.

## Idempotency

- `integration_inbox` unikaalne `(provider, external_event_id)` on lõplik
  kaitse tulevastele operaatoritele.
- `purchase_invoices` unikaalne `(tenant_id, source_type, source_external_id)`
  takistab sama sündmuse duplikaati isegi paralleelse importimise korral.
- Sama XML-faili uuesti importimine tagastab olemasoleva arve
  (`duplicate: true`) ilma uut kannet tegemata.

## Dokumentide turvalisus

- Alla laetakse ainult storage providerist pärast upload-valideerimist.
- Magic byte kontroll, suurusepiir ja MIME-whitelist säilivad.
