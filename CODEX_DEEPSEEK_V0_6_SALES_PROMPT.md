# Codex / DeepSeek tööülesanne – Tilivo v0.6 Sales / Müügiarved

## Eesmärk

Tilivo v0.1 Infrastructure, v0.2 Identity, v0.3 Multi-Tenant + PostgreSQL RLS, v0.4 Platform + Desktop UI ja v0.5 Accounting Core on valmis, testitud ja production’is.

Viimane gate:

```text
V0.5 ACCOUNTING CORE GATE: PASS
```

Nüüd ehita **Tilivo v0.6 Sales / Müügiarved**.

v0.6 eesmärk on valmis saada esimene päriselt kasutatav müügiarvete moodul, mis kasutab v0.5 Accounting Core'i ja loob korrektsed pearaamatukanded.

Ära alusta veel:
- v0.7 Purchases
- v0.8 Banking
- v0.9 Payments
- v0.10 FI VAT reporting/period close
- Payroll
- AI

Kõige tähtsamad invariandid:

> **Arve numbrit ei eraldata drafti loomisel. Number eraldatakse atomically ISSUE hetkel.**

> **Issued invoice ei ole vaikides muudetav. Parandus toimub credit note / reversal loogikaga.**

> **Arve financial effect läheb ledgerisse kontrollitud journal posting engine'i kaudu.**

> **Tenant A ei tohi näha ega muuta Tenant B müügiandmeid. RLS + permission + membership kontroll peavad jääma korraga tööle.**

---

# 1. Preflight

Enne muutmist:

```text
git status
git diff
git remote -v
git log --oneline -15
```

Loe:

- `raamatupidamise_saas_ARCHITECTURE_v2.md`
- `ARCHITECTURE.md`
- `IMPLEMENTATION_STATUS.md`
- `CHANGELOG.md`
- `DEPLOYMENT.md`
- `docs/ACCOUNTING_CORE.md`
- `docs/JOURNAL_MODEL.md`
- `docs/ACCOUNTING_PERIODS.md`
- `docs/CURRENCIES_FX.md`
- `docs/CHART_OF_ACCOUNTS.md`
- `docs/MULTI_TENANCY.md`
- `docs/RLS_SECURITY.md`
- `docs/AUDIT_MODEL.md`
- `docs/ERROR_IDS.md`
- kõik v0.5 ADR-id
- accounting posting engine
- permissions
- audit service
- object/document storage provider
- worker/inbox/outbox foundation
- current desktop UI shell
- CI
- `server.md`

Kontrolli:

```text
v0.5 accounting regression     PASS
v0.4 platform regression       PASS
v0.3 RLS regression            PASS
v0.2 auth regression           PASS
production backup              PASS
restore test                   PASS
DB/API/Web/Worker health       PASS
```

Kui mõni FAIL:
paranda enne v0.6 alustamist.

---

# 2. v0.6 scope

v0.6 peab sisaldama vähemalt:

```text
business_parties / customers
sales_invoices
sales_invoice_lines
invoice_number_series
payment/reference numbers
invoice lifecycle
issue
PDF generation
journal posting linkage
credit note foundation
sales invoice list/detail/editor UI
audit
permissions
RLS
tests
production deploy/smoke
```

Ära ehita veel ostuarveid.

---

# 3. Business party model

Ära tee liiga kitsast `customers` tabelit, kui sama juriidiline isik võib tulevikus olla nii klient kui tarnija.

Eelistus:

```text
business_parties
```

Vähemalt:

```text
id
tenant_id
party_type / capabilities
name
business_id
vat_id
email
phone
address_line1
address_line2
postal_code
city
country_code
language
payment_terms_days
default_currency
iban nullable
e_invoice_address nullable
e_invoice_operator nullable
is_active
created_at
updated_at
```

RLS + FORCE.

Unique business_id/vat_id ainult siis, kui see on riigi/tenant'i sees mõistlik.

Ära eelda, et business_id on alati olemas.

---

# 4. Party roles/capabilities

Eelistus:

```text
is_customer
is_supplier
```

või normaliseeritud `business_party_roles`.

v0.6-s peab vähemalt customer capability olemas olema.

Andmemudel peab võimaldama v0.7-s supplier capability lisada ilma duplicate party't loomata.

---

# 5. Invoice tables

Loo vähemalt:

```text
sales_invoices
sales_invoice_lines
invoice_number_series
```

Vajadusel:

```text
invoice_credit_links
payment_references
```

---

# 6. sales_invoices

Vähemalt:

```text
id UUID
tenant_id UUID
company_id UUID
customer_id UUID
status
invoice_number nullable until ISSUE
series_id
issue_date nullable
due_date
currency_code
language
reference_type
reference_value nullable
customer_snapshot JSONB või struktureeritud snapshot
subtotal
tax_total
total
accounting_journal_entry_id nullable
credit_of_invoice_id nullable
credited_by_invoice_id nullable
created_by
issued_by nullable
created_at
updated_at
issued_at nullable
```

Status näiteks:

```text
DRAFT
ISSUED
CREDITED
CANCELLED_DRAFT
```

Ära tee `PAID` v0.6 source-of-truth staatust ilma v0.8 banking/payment matchinguta.

Kui soovid UI-s näidata "unpaid":
see võib olla derived, mitte authoritative payment state.

---

# 7. sales_invoice_lines

Vähemalt:

```text
id
tenant_id
sales_invoice_id
line_number
description
quantity
unit
unit_price
discount_percent nullable
net_amount
tax_code_id
tax_rate_snapshot
tax_type_snapshot
reporting_mapping_snapshot
tax_amount
gross_amount
revenue_account_id
created_at
```

Kõik money/quantity:

```text
NUMERIC
```

Mitte JS float.

Invoice line peab säilitama applied tax snapshot'i.

---

# 8. Invoice customer snapshot

Issued invoice ei tohi muutuda, kui hiljem customer master data muutub.

Seetõttu ISSUE hetkel snapshoti vähemalt:

```text
customer name
business_id
vat_id
address
email
country
language
```

Kasuta JSONB või struktureeritud snapshot välju.

Ära tee issued invoice PDF'i sõltuvaks live customer tabelist.

---

# 9. Invoice number series

Tabel näiteks:

```text
invoice_number_series
```

Väljad:

```text
id
tenant_id
name
prefix
fiscal_year_id nullable
next_number
is_active
created_at
updated_at
```

Invoice number eraldatakse ainult ISSUE ajal.

Concurrency:

```text
100 parallel invoice issue
→ 100 unique invoice numbers
→ 0 duplicates
```

Ära kasuta application-memory counterit.

DB transaction + row lock / ON CONFLICT atomic increment.

---

# 10. Number format

Näiteks:

```text
2026-000001
INV-2026-000001
```

Ära hardcode'i ühte formaati.

Series konfiguratsioonist:

```text
prefix
year component
padding
```

v0.6-s võib implementation olla lihtne, kuid dokumenteeri.

Gaps võivad rollback/error korral olla lubatud, kui see on teadlik otsus.

Ära tee keerulist gapless süsteemi ilma nõudeta.

---

# 11. Invoice lifecycle

Flow:

```text
DRAFT
→ ISSUE
→ ISSUED
```

DRAFT:
mutable.

ISSUED:
immutable business fields.

Ära luba pärast ISSUE:

```text
customer
lines
prices
tax
currency
invoice_number
issue_date
due_date
```

vaikselt muuta.

Correction:
credit note / replacement.

---

# 12. Issue transaction

Tee üks controlled issue flow.

Näiteks:

```text
issueSalesInvoice(invoiceId, actor)
```

Ühes transaction'is:

1. lock invoice;
2. validate tenant;
3. status DRAFT;
4. customer active;
5. lines >=1;
6. validate tax codes;
7. calculate totals server-side;
8. validate decimal invariants;
9. allocate invoice number;
10. generate payment reference;
11. capture customer snapshot;
12. create accounting journal draft/posted entry;
13. post journal through v0.5 controlled posting engine;
14. mark invoice ISSUED;
15. link journal_entry_id;
16. write audit event;
17. outbox event if needed;
18. commit.

Kui journal posting FAIL:
invoice ISSUE peab rollback'ima.

Ei tohi tekkida:

```text
ISSUED invoice
without ledger entry
```

või

```text
ledger entry
without issued invoice
```

---

# 13. Sales accounting mapping

v0.6 peab looma pearaamatukande.

Näide:

```text
Invoice:
Net   1000.00
VAT    240.00
Gross 1240.00
```

Journal:

```text
D Accounts Receivable 1240.00
C Sales Revenue       1000.00
C VAT Payable          240.00
```

Need kontod ei tohi olla magic hardcoded IDs.

Kasuta company/accounting settings või account mapping foundation:

```text
accounts_receivable_account_id
default_sales_revenue_account_id
tax payable mapping via tax_code / config
```

Kui vajalik mapping puudub:
ISSUE DENY selge Error ID-ga.

---

# 14. Sales settings

Vajadusel lisa:

```text
sales_settings
```

Väljad vähemalt:

```text
tenant_id
company_id
default_invoice_series_id
default_payment_terms_days
accounts_receivable_account_id
default_sales_revenue_account_id
default_language
default_currency
```

RLS + FORCE.

Ära topi account IDs environment config'i.

---

# 15. Revenue account per line

Invoice line võib kasutada:

```text
revenue_account_id
```

Default:
sales_settings.default_sales_revenue_account_id.

Kasutaja võib vajadusel valida muu konto.

Cross-tenant account mapping:
DENY.

Inactive account:
DENY.

---

# 16. Tax code usage

Kasuta v0.5 tax_codes.

v0.6 EI implementeeri täielikku FI VAT return reportingut.

Invoice line peab siiski:

- kasutama effective tax code'i;
- snapshot'ima applied rate/type/reporting mapping;
- arvutama tax amount deterministlikult;
- journal line saab sama tax metadata.

Ära hardcode'i `24%`.

Kõik rate'id data-driven.

---

# 17. VAT calculation

Defineeri selge rounding policy.

Näiteks:

```text
line net
→ line tax
→ line gross
→ invoice totals
```

Kasuta Decimal/NUMERIC.

Ära arvuta authoritative total'e browseris.

Frontend võib preview'd näidata, backend arvutab ISSUE ajal uuesti.

Testi:

```text
0.01
discount
fractional quantity
multiple VAT rates
many small lines
```

---

# 18. Discounts

v0.6-s piisab vähemalt:

```text
discount_percent nullable
```

Kui implementatsioon keerukust kasvatab liiga palju:
võib v0.6-st välja jätta, kuid dokumenteeri.

Kui lisad:
rounding peab olema deterministlik.

Ära lisa line + invoice global discount korraga ilma vajaduseta.

---

# 19. Due date

Due date:

```text
issue_date + payment_terms_days
```

aga user võib draftis due_date üle kirjutada.

ISSUE järel immutable.

Validation:

```text
due_date >= issue_date
```

Kui erand lubatakse:
dokumenteeri.

---

# 20. Finnish payment reference

Loo eraldi provider/service:

```text
PaymentReferenceProvider
```

Implementatsioonid:

```text
FinnishDomesticReferenceProvider
RFCreditorReferenceProvider
```

Vähemalt:

- generate
- validate

Ära sega reference generation invoice numbering loogikasse.

Testid kohustuslikud.

---

# 21. Finnish domestic reference

Toeta Soome viitenumbri checksum'i.

Reference võib olla genereeritud näiteks invoice number'i baasil, kuid loogika peab olema eraldi ja testitud.

Ära genereeri reference't lihtsalt string concat'iga.

Testi standardset 7-3-1 checksum algoritmi ning lisa selged testvektorid.

---

# 22. RF Creditor Reference

Toeta vähemalt generation/validation foundation:

```text
RFxx...
```

Ära tee seda kohustuslikuks defaultiks.

Series/company settings võib tulevikus valida:

```text
FI_DOMESTIC
RF
NONE
```

---

# 23. PDF generation

Tee adapter/service:

```text
InvoicePdfRenderer
```

PDF peab kasutama issued snapshot data't.

PDF vähemalt:

- Tilivo / seller company info
- invoice number
- issue date
- due date
- customer
- business/VAT IDs
- line items
- quantity
- unit price
- VAT
- totals
- payment reference
- IBAN, kui config olemas
- currency
- language

PDF ei tohi sõltuda brauseri screenshot'ist.

Server-side deterministic render.

---

# 24. PDF storage

Issued invoice PDF salvestatakse v0.4 document/object storage'i.

Eelistus:

```text
document type = SALES_INVOICE_PDF
```

või linked document model.

Salvesta:

- storage key
- SHA-256
- mime_type application/pdf
- size
- invoice link
- version

Issued PDF immutable.

Kui PDF regenerated hiljem:
uus version ainult kontrollitud workflow'ga.

---

# 25. PDF / invoice transaction ordering

v0.6 jaoks eelista:

```text
issue accounting transaction commit
→ outbox event
→ PDF worker render
```

UI peab näitama:

```text
PDF_GENERATING
PDF_READY
PDF_FAILED
```

Ära lase PDF render failure'l financial ledger transaction'it lõhkuda pärast commit'i.

---

# 26. Outbox

Kasuta v0.4 outbox foundation'i vähemalt:

```text
SALES_INVOICE_ISSUED
SALES_INVOICE_PDF_REQUESTED
```

Kui tulevikus e-mail/e-invoice provider:
sama event architecture.

Outbox insert samas DB transaction'is invoice issue'ga.

---

# 27. E-mail

Production SMTP on praegu noop.

v0.6-s ära blokeeri invoice ISSUE't SMTP puudumise tõttu.

Tee foundation:

```text
Send invoice
```

võib näidata:

```text
email delivery unavailable
```

või test provider.

Ära muuda Postfixit.

---

# 28. Credit note

v0.6 peab sisaldama credit note foundation'i.

Ära lase issued invoice't editida.

Flow:

```text
original ISSUED
→ create credit invoice
→ inverse financial effect
→ own invoice number
→ link original
→ journal posting
```

Credit invoice ise on eraldi invoice.

Näiteks:

```text
original + full credit = 0
```

Partial credit võib olla lubatud, kui implementation puhas.

Kui partial credit liiga suur selle release jaoks:
tee full credit first, dokumenteeri partial credit TODO.

---

# 29. Credit note accounting

Credit note journal:

```text
D Sales Revenue       1000
D VAT Payable          240
C Accounts Receivable 1240
```

Kasuta accounting posting engine't.

Credit note peab olema oma source:

```text
source_type = SALES_CREDIT_NOTE
source_id = credit_invoice_id
```

Kui v0.5 source_type enum vajab migrationit:
tee kontrollitult.

---

# 30. Duplicate credit race

Concurrency:

```text
same invoice
20 parallel full-credit requests
→ exactly one full credit
```

---

# 31. Cancellation

DRAFT invoice võib:

```text
CANCELLED_DRAFT
```

või soft delete/archive.

ISSUED invoice:
ei cancel'ita lihtsalt ära.

Correction = credit note.

---

# 32. Invoice status semantics

Ära topi payment state'i invoice.status sisse liiga vara.

v0.6:

```text
DRAFT
ISSUED
CREDITED
CANCELLED_DRAFT
```

Hiljem payment state derived:

```text
UNPAID
PARTIALLY_PAID
PAID
OVERDUE
```

v0.8/v0.9 kaudu.

---

# 33. Contacts UI

Desktop-first:

```text
Sales
 ├ Customers
 ├ Invoices
```

Customers table:

```text
Name | Business ID | VAT ID | Email | Country | Status
```

Features:
- search
- add
- edit
- deactivate

Issued invoice history ei tohi muutuda customer editiga.

---

# 34. Invoice list UI

Desktop table:

```text
Invoice | Customer | Issue date | Due date | Total | Status | Actions
```

Filters:

```text
status
date range
customer
```

Search invoice number/customer.

Pagination.

---

# 35. Invoice editor

Desktop-first wide form.

Header:

```text
Customer
Invoice date
Due date
Currency
Language
Reference type
```

Lines:

```text
Description | Qty | Unit | Unit price | Tax | Net | Tax | Total
```

Footer:

```text
Subtotal
VAT
Total
```

Frontend preview:
Decimal-safe.

Backend ISSUE recalculates.

---

# 36. Invoice issued view

Read-only.

Näita:

```text
invoice number
customer snapshot
dates
reference
lines
totals
journal link
PDF status/download
credit note action
audit link
```

No Edit button.

---

# 37. PDF UI

Kui PDF ready:

```text
Download PDF
```

Kui generating:

```text
Generating PDF…
```

Kui failed:

```text
PDF generation failed
Retry
```

Retry permission controlled.

---

# 38. Sales permissions

Lisa vähemalt:

```text
sales.read
sales.customer.manage
invoice.create
invoice.issue
invoice.credit
invoice.pdf.retry
sales.settings.manage
```

Backend authority.

Viewer:
read only.

Employee:
vastavalt role mappingule.

Owner/Admin/Accountant:
mõistlikud õigused.

Dokumenteeri built-in mapping.

---

# 39. Audit events

Lisa vähemalt:

```text
CUSTOMER.CREATED
CUSTOMER.UPDATED
CUSTOMER.DEACTIVATED

SALES_INVOICE.DRAFT_CREATED
SALES_INVOICE.UPDATED
SALES_INVOICE.ISSUED
SALES_INVOICE.CREDIT_CREATED
SALES_INVOICE.CREDIT_ISSUED
SALES_INVOICE.DRAFT_CANCELLED

SALES_INVOICE.PDF_REQUESTED
SALES_INVOICE.PDF_READY
SALES_INVOICE.PDF_FAILED

SALES_SETTINGS.UPDATED
```

ISSUE audit metadata:

```text
invoice_id
invoice_number
customer_id
issue_date
due_date
currency
subtotal
tax_total
total
journal_entry_id
```

No secrets.

---

# 40. Error IDs

Lisa näiteks:

```text
CUST-001 CUSTOMER_NOT_FOUND
CUST-002 CUSTOMER_INACTIVE
CUST-003 INVALID_CUSTOMER

INV-001 INVOICE_NOT_FOUND
INV-002 INVOICE_NOT_DRAFT
INV-003 INVOICE_HAS_NO_LINES
INV-004 INVALID_INVOICE_LINE
INV-005 INVALID_DUE_DATE
INV-006 NUMBER_SERIES_NOT_FOUND
INV-007 ACCOUNT_MAPPING_MISSING
INV-008 TAX_CODE_INVALID
INV-009 INVOICE_IMMUTABLE
INV-010 ALREADY_CREDITED
INV-011 PDF_NOT_READY
INV-012 REFERENCE_INVALID
INV-013 CURRENCY_INVALID
```

Cross-tenant object existence:
ära leki.

---

# 41. RLS

Kõik tenant-owned sales tabelid:

```text
RLS ENABLED
FORCE RLS
```

Testi:

```text
Tenant A customer → Tenant B DENY
Tenant A invoice → Tenant B DENY
Tenant A lines → Tenant B DENY
Tenant A series → Tenant B DENY
Tenant A sales settings → Tenant B DENY
Tenant A PDF metadata → Tenant B DENY
```

No tenant context:
fail-closed.

---

# 42. Tenant-aware foreign keys

Kõik tenant-owned relationships composite FK-ga.

Näiteks:

```text
(tenant_id, customer_id)
→ business_parties(tenant_id,id)

(tenant_id, sales_invoice_id)
→ sales_invoices(tenant_id,id)

(tenant_id, revenue_account_id)
→ accounts(tenant_id,id)

(tenant_id, tax_code_id)
→ tax_codes(tenant_id,id)
```

Ära luba cross-tenant relation'i isegi direct DB-ga.

---

# 43. Idempotency

ISSUE endpoint:

Kui client retry tõttu sama request tuleb kaks korda:
ei tohi teha kahte invoice number'it ega kahte journal entry't.

Kasuta:
- state check
- row lock
- optional idempotency key support

Kui idempotency key foundation lihtne:
lisa `Idempotency-Key`.

Vähemalt:

```text
same invoice issue 20 parallel requests
→ exactly one issued invoice
→ exactly one journal
→ exactly one invoice number
```

---

# 44. Accounting linkage

`sales_invoices.accounting_journal_entry_id`

Unique/controlled.

Journal:

```text
source_type = SALES_INVOICE
source_id = invoice_id
```

Credit:

```text
source_type = SALES_CREDIT_NOTE
source_id = credit_invoice_id
```

Test:
üks invoice ei saa siduda kahte posting journalit.

---

# 45. Invoice totals invariant

Backend ISSUE ajal:

```text
subtotal = SUM(line net)
tax_total = SUM(line tax)
total = subtotal + tax_total
```

DB/service validation.

Frontend väärtusi ei usaldata.

Test hostile request:
client saadab valed totals → backend ignore/recompute.

---

# 46. Invoice line arithmetic

Vähemalt:

```text
net = quantity * unit_price - discount
tax = round(net * tax_rate)
gross = net + tax
```

Vali line-level rounding policy ja dokumenteeri.

Ära kasuta JS float'i.

---

# 47. Multi-tax invoice

Test:

```text
line 1 VAT A
line 2 VAT B
line 3 zero/exempt
```

Journal peab agregeerima revenue/tax read korrektselt.

Võid agregeerida account/tax kaupa või luua line-by-line journal lines.

Vali üks, dokumenteeri.

Eelistus:
deterministlik aggregation account + tax code järgi.

---

# 48. Zero/exempt/reverse tax foundation

v0.6 ei tee täielikku VAT return'i, aga invoice peab suutma kasutada tax code tüüpe:

```text
STANDARD
REDUCED
ZERO
EXEMPT
REVERSE_CHARGE
```

Ära hardcode'i Soome reverse-charge accountingut ilma country rules engine'ita.

Kui reverse charge müügiarve vajab eraldi logic'ut, võib v0.6-s piirata scope'i ja dokumenteerida.

---

# 49. Finland starter behavior

Company country = FI.

Default:
- currency EUR
- domestic reference available
- payment terms from sales settings
- customer language from party

Ära väida, et invoice PDF on täielik õiguslik compliance, kui required-field registry pole veel v0.10/Finland requirements review'ga lõplikult kinnitatud.

Aga lisa vajalikud põhilised väljad.

---

# 50. Invoice numbering concurrency test

Kohustuslik:

```text
100 parallel DRAFT invoices
→ issue concurrently
→ 100 unique invoice numbers
→ 100 journal entries
→ 0 duplicate
```

---

# 51. Same invoice double issue

```text
same draft invoice
20 parallel issue
→ exactly one success
→ exactly one invoice number
→ exactly one journal
→ exactly one issued audit
```

---

# 52. Credit race

```text
same issued invoice
20 parallel full credit
→ exactly one credit invoice
→ one credit journal
```

---

# 53. PDF worker idempotency

```text
same PDF job processed twice
→ one logical document/version
```

Kui retry:
ei tohi tekitada duplicate visible PDF-e.

---

# 54. Outbox idempotency

Invoice issue outbox event:

```text
exactly one logical event
```

Worker retry:
safe.

---

# 55. Direct DB immutability tests

Runtime role:

ISSUED invoice:
UPDATE → DENY
DELETE → DENY

Issued lines:
UPDATE → DENY
DELETE → DENY

Credit link:
tamper → DENY

Invoice number:
UPDATE → DENY

---

# 56. API

Minimaalne:

```text
GET/POST/PATCH /api/v1/customers
GET /api/v1/customers/:id

GET/POST /api/v1/sales/invoices
GET/PATCH /api/v1/sales/invoices/:id
POST /api/v1/sales/invoices/:id/issue
POST /api/v1/sales/invoices/:id/credit
POST /api/v1/sales/invoices/:id/cancel-draft

GET /api/v1/sales/invoices/:id/pdf
POST /api/v1/sales/invoices/:id/pdf/retry

GET/PATCH /api/v1/sales/settings
```

Ära lisa send-email endpointi, kui SMTP pole päriselt olemas, välja arvatud foundation.

---

# 57. E2E

Playwright vähemalt:

```text
create customer
create invoice draft
add line
totals preview
issue invoice
invoice becomes read-only
invoice number visible
PDF eventually ready
download PDF
journal link visible
create credit note
original shows credited state
```

Desktop-first.

Mobile basic responsive smoke.

---

# 58. Security hostile tests

Vähemalt:

```text
cross-tenant customer read
cross-tenant invoice read
cross-tenant line read
cross-tenant issue
cross-tenant credit
cross-tenant PDF download
cross-tenant series
cross-tenant account mapping
client total spoof
client tenant_id spoof
issued mutation
number mutation
duplicate issue
duplicate credit
missing permission
missing tenant context
```

---

# 59. PDF security

Test:

- PDF endpoint auth required
- tenant ownership required
- no public object path
- no path traversal
- content-disposition safe filename
- PDF metadata no secrets
- storage SHA-256 valid

---

# 60. Backup/restore

Enne production migrationit:

```text
DB backup
DB restore isolated
document/object backup
object restore/hash
```

PASS.

v0.5 → v0.6 upgrade test:

- accounting data preserved
- documents preserved
- tenants/users preserved

---

# 61. Migration order

Soovitus:

1. business_parties
2. invoice series
3. sales settings
4. sales invoices
5. sales invoice lines
6. credit link constraints
7. RLS/FORCE
8. grants
9. immutability triggers
10. permissions
11. source_type extension
12. indexes
13. tests

Ära productionis destructive down migrationit.

---

# 62. CI

CI peab jooksutama:

```text
lint
typecheck
auth regression
RLS regression
platform regression
accounting regression
sales unit
sales integration
sales RLS/security
invoice concurrency
credit race
PDF worker tests
Playwright
production build
npm audit
```

---

# 63. Documentation

Loo/uuenda:

```text
docs/SALES.md
docs/INVOICE_LIFECYCLE.md
docs/INVOICE_NUMBERING.md
docs/PAYMENT_REFERENCES.md
docs/INVOICE_PDF.md
docs/CREDIT_NOTES.md

ARCHITECTURE.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
DEPLOYMENT.md
docs/ERROR_IDS.md
```

ADR-id vajadusel, kasutades järgmisi vabu numbreid vastavalt repo tegelikule seisule.
Ära kirjuta olemasolevaid ADR-e üle.

---

# 64. Production deploy gate

Deploy ainult kui:

```text
v0.5 regression             PASS
fresh v0.6 migration        PASS
v0.5→v0.6 upgrade           PASS
invoice numbering race      PASS
same invoice double issue   PASS
accounting linkage          PASS
invoice totals              PASS
issued immutability         PASS
credit note                 PASS
credit race                 PASS
references                  PASS
PDF generation              PASS
PDF storage                 PASS
PDF security                PASS
sales RLS                   PASS
cross-tenant hostile tests  PASS
Playwright                  PASS
backup/restore              PASS
npm audit                   PASS
```

---

# 65. Production migration

Enne:
backup + restore PASS.

Seejärel:

```text
migrate
verify schema
verify RLS
verify grants
verify v0.5 accounting untouched
```

---

# 66. Production smoke

Kasuta QA tenant'i.

Flow:

```text
create customer
create invoice draft
add 2 lines
issue
verify invoice number
verify reference
verify totals
verify journal
verify trial balance still balanced
verify PDF generated
download PDF
verify SHA-256
attempt issued edit → DENY
create full credit
verify credit journal
verify original + credit net effect 0
cross-tenant invoice access → DENY
cross-tenant PDF → DENY
```

---

# 67. Existing services

Pärast deploy'd kontrolli:

```text
Tilivo DB/API/Web/Worker
nginx
Docker
MariaDB
host PostgreSQL
postfix
cloudflared
fail2ban
wordgame
multipower
baltik
mrjaak
server.md muud teenused
```

Kõik PASS.

---

# 68. Public production

Tilivo on internet-facing.

Ära lisa:

- public invoice PDF path
- unauthenticated invoice endpoint
- debug customer endpoint
- raw SQL endpoint
- test bypass
- exposed internal account IDs without auth
- production dev e-mail token path

---

# 69. v0.6 mini security/accounting review

Enne gate PASS-i kontrolli:

```text
duplicate invoice number
double issue
issued mutation
journal mismatch
unbalanced sales posting
tax rounding mismatch
reference checksum
credit duplication
cross-tenant sales leak
PDF cross-tenant leak
PDF duplicate job
outbox duplicate
permission escalation
audit integrity regression
```

CRITICAL/HIGH = 0 open.

---

# 70. Git

Tee loogilised commitid.

Näiteks:

```text
feat: add business parties and sales settings
feat: add invoice lifecycle and atomic numbering
feat: post issued invoices to accounting core
feat: add payment reference providers
feat: add invoice pdf generation
feat: add credit note workflow
feat: add sales desktop ui
test: add sales concurrency and isolation coverage
docs: document Tilivo sales module
```

Push:

```text
https://github.com/jeerum/Tilivo
main
```

No force push.
No secrets.
Working tree clean.

---

# 71. Stop conditions

Peata ja küsi ainult reaalse blockeriga:

- backup FAIL
- restore FAIL
- migration data-loss risk
- invoice ISSUE võib commit'ida ilma journalita
- duplicate invoice number race
- issued invoice mutation bypass
- cross-tenant sales leak
- decimal/tax arithmetic unresolved mismatch
- PDF storage leak
- production migration risk
- muu serveriteenus saaks kahjustada
- credential/user approval päriselt vajalik

Need EI OLE blockerid:

- tööpakett on suur
- testid/UI on veel tegemata
- järgmine samm oleks...
- ühe turn'i pikkus

Ära peatu põhjendusega "jätkame järgmises turn'is", kui päris stop condition puudub.

---

# 72. Final report

Anna lõpus:

## 1. Business parties

```text
Customer CRUD:
Snapshot:
RLS:
```

## 2. Invoice lifecycle

```text
Draft:
Issue:
Issued immutable:
Cancel draft:
Credit:
```

## 3. Numbering

```text
Atomic:
100 parallel:
Double issue:
Duplicates:
```

## 4. References

```text
FI domestic:
RF:
Validation:
```

## 5. Accounting

```text
AR:
Revenue:
Tax:
Journal linkage:
Trial balance:
Credit net effect:
```

## 6. PDF

```text
Renderer:
Outbox:
Worker:
Storage:
SHA-256:
Download auth:
Cross-tenant deny:
Idempotency:
```

## 7. RLS/security

```text
Customers:
Invoices:
Lines:
Series:
Settings:
PDF:
Cross-tenant:
Issued mutation:
```

## 8. UI

```text
Customers:
Invoice list:
Invoice editor:
Issued read-only:
PDF:
Credit:
Desktop:
Mobile:
```

## 9. Tests

Täpsed käsud ja pass counts.

## 10. Production

```text
Backup:
Restore:
Migration:
DB:
API:
Web:
Worker:
HTTPS:
Invoice smoke:
Journal smoke:
PDF smoke:
Credit smoke:
Cross-tenant deny:
```

## 11. Existing services

PASS/FAIL.

## 12. GitHub

```text
repo:
branch:
latest commit:
push:
working tree:
```

## 13. Open risks

Kõik MEDIUM/LOW/INFO.

## 14. Final gate

Kirjuta üks:

```text
V0.6 SALES GATE: PASS
```

või:

```text
V0.6 SALES GATE: FAIL
```

Kui PASS:

```text
STOP – v0.7 Purchases ei alusta.
```

Kui FAIL:
näita täpsed tehnilised blockerid.

---

# 73. Alusta nüüd

```text
Read docs/repo
→ preflight
→ backup/restore
→ sales schema design
→ migrations
→ business parties
→ sales settings
→ invoice drafts
→ decimal/tax calculation
→ numbering
→ payment references
→ issue transaction
→ accounting linkage
→ PDF outbox/worker/storage
→ credit notes
→ audit/permissions/error IDs
→ desktop UI
→ unit/integration/RLS/security tests
→ concurrency/idempotency tests
→ Playwright
→ full regression
→ mini security/accounting review
→ production backup
→ migrate/deploy
→ production smoke
→ verify old services
→ docs
→ Git push
→ V0.6 SALES GATE
→ STOP
```

Kõige tähtsamad nõuded:

> **Invoice number eraldatakse ainult ISSUE hetkel ja peab olema concurrency-safe.**

> **ISSUED invoice on immutable.**

> **Invoice ISSUE ja accounting journal peavad olema ühe kontrollitud financial transaction flow kaks osa.**

> **Credit note parandab issued invoice'i, mitte ei kirjuta ajalugu ümber.**

> **Kõik authoritative summad arvutatakse backendis Decimal/NUMERIC abil.**

> **PDF on authitud tenant-owned dokument, mitte public static fail.**
