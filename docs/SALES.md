# Tilivo Sales (v0.6)

Müügiarvete moodul on esimene päriselt kasutatav arveldusvoog, mis postitab
kõik arved läbi v0.5 kontrollitud pearaamatu-postituse.

## Ulatus

- `business_parties` – ühine juriidiliste isikute tabel `is_customer` /
  `is_supplier` lippudega; v0.7 saab lisada tarnijakasutuse ilma duplikaatideta.
- `invoice_number_series` – arve numbri seeriad, `next_number` suurendatakse
  ainult ISSUE ajal.
- `sales_settings` – üks rida tenandi kohta: AR-konto, tulukonto,
  käibemaksukonto, vaikeseeria, maksetähtajad, valuuta/keel, viite tüüp.
- `sales_invoices` / `sales_invoice_lines` – DRAFT -> ISSUED -> CREDITED ning
  CANCELLED_DRAFT; issued andmed on immuutselt salvestatud (snapshot).
- `sales_invoice_pdfs` – PDF olek ja dokumentide link.
- `sales_invoice_credit_links` – insert-only täiskreedi link.

## API

```text
GET/POST/PATCH /api/v1/customers
GET           /api/v1/customers/:id
POST          /api/v1/customers/:id/deactivate|activate

GET/POST      /api/v1/sales/series
PATCH         /api/v1/sales/series/:id
GET/PATCH     /api/v1/sales/settings

GET/POST      /api/v1/sales/invoices
GET/PATCH     /api/v1/sales/invoices/:id
POST          /api/v1/sales/invoices/:id/issue
POST          /api/v1/sales/invoices/:id/credit
POST          /api/v1/sales/invoices/:id/cancel-draft
GET           /api/v1/sales/invoices/:id/pdf
POST          /api/v1/sales/invoices/:id/pdf/retry
```

Kõik read/write otspunktid nõuavad sessiooni + tenant headerit
(`x-tilivo-tenant-id`); mutatsioonid nõuavad CSRF tokenit.

## Õigused

| Roll | Sales |
| --- | --- |
| Owner / Admin | kõik sales.* / invoice.* |
| Accountant | sales.read, customer.manage, invoice create/issue/credit/pdf.retry |
| Employee / Viewer | sales.read |

Backend kontrollib alati `tilivo_has_permission` ja `resolveTenantAccess`.

## Arvelduse põhivood

- Draft on muudetav ja ilma numbrita.
- ISSUE on üks transaction: ridade serveripoolne ümberarvutus, seeria
  atomiline number, makseviide, kliendi snapshot, pearaamatukanne (AR / tulu /
  käibemaks), arve staatuse muutus, PDF-outbox sündmus.
- Issued arve on muutumatu; parandus toimub täiskrediidiga.
- Kreeditarve on iseseisev arve oma numbriga; selle kanne peegeldab algse
  arve kande.

Vaata lähemalt:

- [INVOICE_LIFECYCLE.md](INVOICE_LIFECYCLE.md)
- [INVOICE_NUMBERING.md](INVOICE_NUMBERING.md)
- [PAYMENT_REFERENCES.md](PAYMENT_REFERENCES.md)
- [INVOICE_PDF.md](INVOICE_PDF.md)
- [CREDIT_NOTES.md](CREDIT_NOTES.md)
