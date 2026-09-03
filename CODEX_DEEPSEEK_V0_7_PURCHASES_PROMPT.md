# Codex / DeepSeek tööülesanne – Tilivo v0.7 Purchases / Ostuarved + e-arve foundation

## Eesmärk

Tilivo v0.1 Infrastructure, v0.2 Identity, v0.3 Multi-Tenant + PostgreSQL RLS, v0.4 Platform + Desktop UI, v0.5 Accounting Core ja v0.6 Sales on valmis, testitud ja production’is.

Viimane gate:

```text
V0.6 SALES GATE: PASS
```

Nüüd ehita **Tilivo v0.7 Purchases / Ostuarved**.

v0.7 eesmärk on valmis saada päriselt kasutatav ostuarvete töövoog:

```text
supplier
→ incoming document / e-invoice
→ extraction / parsing
→ purchase invoice draft
→ review
→ approval
→ accounting posting
→ immutable approved/posted history
```

Lisaks peab v0.7 looma tugeva **e-arve ingestion foundation'i** Finvoice / PEPPOL / TEAPPSXML jaoks, ilma et me läheks veel pangamaksete või v0.8 Banking juurde.

Ära alusta veel:

- v0.8 Banking
- v0.9 Payments
- v0.10 FI VAT reporting/period close
- Payroll
- Rules Engine
- AI assistant

Kõige tähtsamad invariandid:

> **Üks incoming supplier invoice ei tohi retry/import concurrency tõttu tekitada mitut sama ostuarvet ega mitut pearaamatukannet.**

> **Approved/POSTED purchase invoice financial fields ei ole tavakasutaja poolt vaikselt muudetavad. Parandus toimub kontrollitud reversal/correction workflow kaudu.**

> **Purchase invoice accounting effect peab minema ainult v0.5 controlled journal posting engine'i kaudu.**

> **Originaaldokument ja kinnitatud document version jäävad immutable; uus fail tähendab uut versionit.**

> **Tenant A ei tohi näha ega muuta Tenant B supplierit, ostuarvet, dokumenti, extraction data't ega journal linkage'it.**

---

# 1. Preflight

Enne muutmist:

```text
git status
git diff
git remote -v
git log --oneline -15
```

Loe täielikult:

- `raamatupidamise_saas_ARCHITECTURE_v2.md`
- `ARCHITECTURE.md`
- `IMPLEMENTATION_STATUS.md`
- `CHANGELOG.md`
- `DEPLOYMENT.md`
- `docs/ACCOUNTING_CORE.md`
- `docs/JOURNAL_MODEL.md`
- `docs/DOCUMENT_STORAGE.md`
- `docs/INBOX_OUTBOX.md`
- `docs/AUDIT_MODEL.md`
- `docs/SALES.md`
- `docs/INVOICE_LIFECYCLE.md`
- `docs/MULTI_TENANCY.md`
- `docs/RLS_SECURITY.md`
- `docs/ERROR_IDS.md`
- kõik ADR-id
- v0.5 posting engine
- v0.6 business_parties mudel
- v0.6 tax snapshot / decimal calculation
- object storage provider
- file scanner provider
- inbox/outbox worker
- permissions/audit
- CI
- `server.md`

Kontrolli:

```text
v0.6 sales regression          PASS
v0.5 accounting regression     PASS
v0.4 platform regression       PASS
v0.3 RLS regression            PASS
v0.2 auth regression           PASS
production DB backup           PASS
DB restore test                PASS
object backup                  PASS
object restore/hash            PASS
DB/API/Web/Worker health       PASS
```

Kui mõni FAIL:
paranda see enne v0.7 alustamist.

---

# 2. Tööpaketi suurus EI OLE stop condition

v0.7 on suur, kuid:

```text
"pakett on suur"
"testid/UI on veel tegemata"
"jätkame järgmises turnis"
"järgmine samm oleks..."
```

EI OLE piisav põhjus peatuda.

Tee töö väikeste kontrollitud sammudena:

```text
implement
→ test
→ fix
→ commit
→ continue
```

Peatu ainult päris tehnilise või andmeturbe blockeriga, mis on loetletud selle prompti lõpus.

---

# 3. v0.7 scope

v0.7 peab sisaldama vähemalt:

```text
supplier capability business_parties mudelis
purchase_invoices
purchase_invoice_lines
purchase_invoice_documents / linkage
incoming invoice ingestion
canonical incoming invoice model
Finvoice parser/adapter foundation
PEPPOL BIS parser/adapter foundation
TEAPPSXML parser/adapter foundation
PDF/JPG/PNG upload flow
OCR provider foundation
structured extraction fields + confidence/source
supplier matching
duplicate detection
review workflow
approval workflow
accounting posting
purchase correction/reversal foundation
permissions
audit
RLS
desktop-first UI
tests
production deploy/smoke
```

---

# 4. Business parties – supplier capability

Kasuta v0.6 `business_parties` mudelit.

Ära loo eraldi duplicate `suppliers` master tabelit, kui selleks pole tugevat põhjust.

Lisa või aktiveeri supplier capability:

```text
is_supplier = true
```

või olemasoleva normaliseeritud role/capability mudeli järgi.

Supplier fields vähemalt:

```text
name
business_id
vat_id
email
phone
address
country_code
language
default_currency
payment_terms_days
iban
e_invoice_address
e_invoice_operator
is_active
```

RLS + FORCE säilib.

Sama party võib olla:

```text
customer + supplier
```

---

# 5. purchase_invoices

Loo vähemalt:

```text
purchase_invoices
purchase_invoice_lines
```

Vajadusel eraldi:

```text
purchase_invoice_documents
purchase_invoice_approvals
purchase_invoice_extractions
purchase_invoice_external_ids
```

Ära topi kogu lifecycle'i ühte JSON välja.

---

# 6. Purchase invoice põhiväljad

`purchase_invoices` vähemalt:

```text
id UUID
tenant_id UUID
company_id UUID
supplier_id UUID nullable until matched
status
supplier_invoice_number
invoice_date
due_date
currency_code
supplier_reference nullable
supplier_iban nullable
source_type
source_external_id nullable
supplier_snapshot
subtotal
tax_total
total
accounting_journal_entry_id nullable
created_by
reviewed_by nullable
approved_by nullable
posted_by nullable
created_at
updated_at
reviewed_at nullable
approved_at nullable
posted_at nullable
```

Status näiteks:

```text
INGESTED
DRAFT
NEEDS_REVIEW
READY_FOR_APPROVAL
APPROVED
POSTED
REJECTED
CANCELLED_DRAFT
CORRECTED
```

Kui lihtsam state machine on parem:
vali väiksem, kuid üheselt defineeritud mudel.

Ära kasuta `PAID` v0.7-s.

Payment state tuleb hiljem Banking/Payments kaudu.

---

# 7. Purchase invoice line

Vähemalt:

```text
id
tenant_id
purchase_invoice_id
line_number
description
quantity nullable
unit nullable
unit_price nullable
net_amount
tax_code_id nullable
tax_rate_snapshot
tax_type_snapshot
reporting_mapping_snapshot
tax_amount
gross_amount
expense_account_id
cost_center nullable foundation only
created_at
updated_at while draft/reviewable
```

Kõik money:

```text
NUMERIC
Decimal/string based
no JS float
```

---

# 8. Supplier snapshot

Kui invoice saab APPROVED/POSTED, snapshot'i supplieri oluline info:

```text
name
business_id
vat_id
address
country
IBAN
e_invoice_address/operator
```

Master supplier hilisem muutmine ei tohi muuta ajaloolist ostuarvet.

---

# 9. Supplier invoice uniqueness / duplicate detection

Supplier invoice number ei pruugi olla globaalselt unikaalne.

Duplicate detection kasuta vähemalt kombinatsiooni:

```text
tenant_id
supplier_id / supplier identity
supplier_invoice_number
invoice_date
total
currency
```

Kui source annab tugeva external ID:
kasuta seda idempotency võtmena.

E-arve puhul:

```text
(provider, external_event_id)
```

või:

```text
(source_type, source_external_id)
```

unique vastavalt disainile.

Ära tee pimedat UNIQUE supplier_invoice_number üksinda.

---

# 10. Incoming source types

Toeta vähemalt foundation:

```text
MANUAL
UPLOAD_PDF
UPLOAD_IMAGE
FINVOICE
PEPPOL
TEAPPSXML
EMAIL
API
```

EMAIL võib v0.7-s olla ainult domain/adapter foundation, kui mailbox ingestion puudub.

Ära muuda Postfix konfiguratsiooni.

---

# 11. Canonical incoming invoice model

Tee adapteritest sõltumatu internal model, näiteks:

```text
CanonicalPurchaseInvoice
```

Väljad vähemalt:

```text
supplier identifiers
supplier name
invoice number
invoice date
due date
currency
payment reference
IBAN
lines
tax summaries
totals
source metadata
external identifiers
```

Finvoice/Peppol/TEAPPSXML parserid mapivad kõik sellesse mudelisse.

Business logic ei tohi olla seotud konkreetse XML skeemi külge.

---

# 12. InvoiceProvider / parser architecture

Tee selged adapterid, näiteks:

```text
IncomingInvoiceParser
FinvoiceAdapter
PeppolBisAdapter
TeappsXmlAdapter
```

Kui päris operator API ühendust v0.7-s ei ole:
ära fake'i seda.

v0.7 PASS võib põhineda:

```text
XML upload/import
→ parser
→ canonical invoice
→ purchase invoice
```

Real operator integration tuleb hiljem adapteri kaudu.

---

# 13. Finvoice foundation

Toeta vähemalt üks dokumenteeritud Finvoice 3.x sisendvariant, kui olemasoleva repo/tehnilise info põhjal kindlalt implementeeritav.

Ära tee XML parsingut regexiga.

Kasuta turvalist XML parserit:

- external entity disabled
- DTD disabled
- entity expansion attack protection
- size limit

Testi:

```text
valid invoice
malformed XML
XXE payload
oversized XML
missing mandatory fields
duplicate external id
```

---

# 14. PEPPOL BIS foundation

Tee adapteri struktuur vähemalt PEPPOL BIS Billing XML jaoks.

Kui v0.7 jooksul täis mapping pole realistlik:
implementeeri minimaalne ingestion + canonical mapping, mis katab:

```text
supplier
invoice number
dates
currency
lines
tax
totals
payment means/reference
```

Ära väida täielikku PEPPOL compliance'i ilma ametliku validation stackita.

Dokumenteeri coverage.

---

# 15. TEAPPSXML foundation

Sama põhimõte:

```text
TEAPPSXML
→ secure XML parser
→ canonical invoice
```

Kui skeemi variante on mitu:
parser peab version/source metadata säilitama.

Ära hardcode'i ühe operaatori eriloogikat core domain'i.

---

# 16. Inbox integration

Kasuta v0.4 `integration_inbox`.

Incoming external invoice flow:

```text
receive
→ register inbox event
→ deduplicate
→ parse
→ create/attach purchase invoice
→ mark processed
```

Kui processing failib:

```text
status FAILED
attempt_count
last_error_code
```

Original event ei kao.

---

# 17. Idempotency

Kohustuslik:

```text
same external invoice event 100 times
→ 1 purchase invoice
→ 1 logical source document
→ 1 accounting effect maximum
```

Inbox unique constraint peab olema lõplik kaitse, mitte ainult app-level check.

---

# 18. PDF/JPG/PNG upload

Kasuta v0.4 document storage'it.

Flow:

```text
upload
→ document/version
→ SHA-256
→ scanner status
→ extraction
→ purchase invoice draft/review
```

Allowed vähemalt:

```text
PDF
JPEG
PNG
```

Size limit vastavalt v0.4 policy'le.

Magic byte kontroll säilib.

---

# 19. Document linkage

Üks purchase invoice võib olla seotud ühe või mitme source document versioniga.

Tee explicit relation, näiteks:

```text
purchase_invoice_documents
```

Väljad:

```text
tenant_id
purchase_invoice_id
document_id
document_version_id
role
created_at
```

Role näiteks:

```text
SOURCE
ATTACHMENT
CORRECTION
```

Composite tenant FK-d.

---

# 20. Confirmed source document immutability

Kinnitatud source document version:

```text
immutable
```

Purchase invoice correction ei tohi vana source PDF/JPG/XML sisu üle kirjutada.

Replacement:
uus document version / uus relation.

---

# 21. OCR provider foundation

Tee adapter:

```text
OcrProvider
```

Implementatsioon näiteks:

```text
NoopOcrProvider
Local/TestOcrProvider
```

Kui productionis päris OCR providerit pole:
ära fake'i extracted väärtusi.

Manual review peab töötama ilma OCR-ta.

Ära lisa AI/LLM extractionit v0.7-s.

---

# 22. Extraction model

OCR/parser extracted field ei ole source of truth enne user review/approval'i.

Iga extracted field foundation peab toetama:

```text
field_name
value
confidence
source
source_region / page / xpath nullable
created_at
```

Näiteks:

```text
supplier_name
invoice_number
invoice_date
due_date
total
vat_total
iban
reference
```

Confidence võib puududa structured XML puhul või olla 1.0/documented.

---

# 23. Structured XML confidence

Finvoice/Peppol/TEAPPSXML puhul:

```text
source = STRUCTURED_XML
```

OCR ei ole vajalik.

Ära degradeeri structured XML väärtusi OCR-iga.

Kui XML ja rendered PDF erinevad:
structured invoice data on parser input; dokumenteeri conflict workflow.

---

# 24. Supplier matching

Tee deterministic matching foundation.

Eelistatud signaalid:

```text
business_id
vat_id
e_invoice_address
IBAN
exact normalized name
```

Ära kasuta fuzzy AI-d v0.7-s.

Kui üks kindel match:
assign supplier.

Kui ambiguous:
NEEDS_REVIEW.

Kui puudub:
kasutaja saab valida olemasoleva või luua supplieri.

---

# 25. Supplier matching auditability

Kui supplier auto-match toimus:
salvesta põhjus näiteks:

```text
MATCH_BUSINESS_ID
MATCH_VAT_ID
MATCH_EINVOICE_ADDRESS
MATCH_IBAN
```

UI võib näidata:

```text
Matched by VAT ID
```

---

# 26. Purchase invoice lifecycle

Soovituslik flow:

```text
INGESTED
→ NEEDS_REVIEW
→ READY_FOR_APPROVAL
→ APPROVED
→ POSTED
```

Manual entry:

```text
DRAFT
→ READY_FOR_APPROVAL
```

Reject:

```text
NEEDS_REVIEW / READY_FOR_APPROVAL
→ REJECTED
```

Ära lase APPROVED/POSTED invoice't tagasi DRAFT'i.

---

# 27. Review step

Review tähendab:

- supplier confirmed
- invoice number
- dates
- currency
- totals
- lines
- tax codes
- expense accounts
- source document

Kõik peab olema server-side valideeritud.

---

# 28. Approval step

Tee vähemalt:

```text
approvePurchaseInvoice(invoiceId, actor)
```

Permission:

```text
purchase.approve
```

Ära eelda, et invoice creator = approver.

Four-eyes foundation peab olema võimalik.

Kui tenant settings nõuab separation of duties:
creator ei tohi approve'ida oma invoice't.

v0.7-s võib see olla configurable foundation.

---

# 29. Approval config

Vajadusel:

```text
purchase_settings
```

Väljad näiteks:

```text
accounts_payable_account_id
default_expense_account_id
require_separate_approver
auto_post_on_approval
default_currency
```

Ära hardcode'i AP account ID-d.

---

# 30. APPROVED vs POSTED

Vali teadlik mudel.

Soovitus:

```text
APPROVED = business approval complete
POSTED = accounting journal successfully posted
```

Kui `auto_post_on_approval=true`:
approval transaction võib kohe posting flow käivitada.

Kui posting failib:
ei tohi jääda eksitavalt POSTED.

Võid jääda APPROVED + POSTING_ERROR/TODO state'i või rollback approval'i vastavalt disainile.

Dokumenteeri ADR-is.

---

# 31. Purchase accounting mapping

Näide:

```text
Supplier invoice:
Net  1000.00
VAT   240.00
Gross 1240.00
```

Journal:

```text
D Expense / Asset       1000.00
D Input VAT              240.00
C Accounts Payable      1240.00
```

Kõik kontod peavad tulema:

```text
line expense_account_id
tax code/account mapping
purchase_settings.accounts_payable_account_id
```

Mitte magic IDs.

---

# 32. Tax handling

Kasuta v0.5 tax_codes.

Purchase line snapshot:

```text
tax_code_id
applied_tax_rate
tax_type_snapshot
reporting_mapping_snapshot
```

v0.7 ei tee veel VAT return'i.

Aga posting peab säilitama ajaloolise tax semantics'i.

---

# 33. Input VAT account mapping

Ära hardcode'i ühte VAT input account'i kogu maailmale.

Tee foundation:

```text
tax code / accounting mapping
```

või purchase settings + tax category mapping.

Kui vajalik mapping puudub:
posting DENY selge Error ID-ga.

---

# 34. Reverse charge foundation

Soome ehituse reverse VAT ja muud reverse-charge juhtumid vajavad eraldi tax treatment'i.

v0.7:

- peab suutma tax code tüüpi `REVERSE_CHARGE` säilitada;
- ei tohi käsitleda seda lihtsalt `0% VAT`-na;
- posting mapping võib olla piiratud ainult siis, kui see on dokumenteeritud ja testitud.

Täielik FI VAT reporting tuleb v0.10.

---

# 35. Multi-line / multi-account invoice

Üks ostuarve võib jaguneda:

```text
tools expense
materials expense
vehicle expense
asset account
```

Iga line võib kasutada erinevat expense/account mappingut.

Journal peab jääma balanced.

---

# 36. Expense account suggestion

Ära lisa AI-d.

Võid teha deterministic default'i:

```text
supplier default expense account
purchase settings default expense account
```

Kui soovid:
business_party supplier profile võib sisaldada:

```text
default_expense_account_id
default_tax_code_id
```

Need on ainult default/suggestion.

User saab review's muuta.

---

# 37. Duplicate supplier invoice UX

Kui süsteem leiab võimaliku duplicate:

```text
DUPLICATE_POSSIBLE
```

Näita põhjused:

```text
same supplier
same invoice number
same total
same date
same external ID
```

Strong duplicate:
blokib posting/approval.

Weak similarity:
warning + manual decision.

Ära lase AI-l seda otsustada.

---

# 38. Exact duplicate hard protection

Kui sama:

```text
tenant
supplier
normalized supplier_invoice_number
```

ja mõlemad on aktiivsed/posted ning business case järgi duplicate ei ole lubatud:
tee DB-level protection või controlled duplicate override workflow.

Ära blokeeri reaalseid juhtumeid, kus supplier invoice number võib korduda eri aastatel, kui seda peab toetama.

Vali composite invariant teadlikult.

---

# 39. Invoice number normalization

Supplier invoice number:

- preserve original display
- normalized comparison field eraldi
- trim
- case normalization ainult kui mõistlik
- whitespace/hyphen normalization ainult duplicate detection'i jaoks, mitte originaali hävitamiseks.

---

# 40. Purchase correction / reversal

POSTED purchase invoice financial fields:
immutable.

Correction flow v0.7 foundation:

```text
posted invoice
→ create correction/reversal transaction
→ reversal journal
→ corrected replacement invoice või correction record
```

Kui supplier credit note ingestion on puhtalt tehtav:
lisa `PURCHASE_CREDIT_NOTE`.

Kui see kasvatab liiga palju scope'i:
tee vähemalt controlled accounting reversal + corrected invoice foundation.

Ära luba posted invoice silent edit'i.

---

# 41. Supplier credit note foundation

Ideaalne:

```text
document_type = INVOICE / CREDIT_NOTE
```

Credit note posting:

```text
C Expense / Asset
C Input VAT
D Accounts Payable
```

vastavalt line'idele.

Kui täis supplier credit note workflow v0.7-s ei jõua:
dokumenteeri selge TODO, kuid direct posted edit jääb keelatuks.

---

# 42. Payment details

v0.7 võib salvestada:

```text
supplier IBAN
reference
due date
amount
```

Aga:

```text
EI tee pangamakset
EI loo pain.001
EI märgi PAID
```

Need tulevad v0.9.

---

# 43. Purchase permissions

Lisa vähemalt:

```text
purchase.read
purchase.create
purchase.edit
purchase.review
purchase.approve
purchase.post
purchase.reject
purchase.correct
supplier.manage
purchase.settings.manage
purchase.document.upload
```

Backend on autoriteet.

Role mapping dokumenteeri.

---

# 44. Separation of duties

Kui `require_separate_approver=true`:

```text
created_by == approver
→ DENY
```

Testi.

Kui false:
Owner/Admin/Accountant võib vastavalt permissionile approve'ida.

Ära hardcode'i ühte poliitikat kõigile tenantidele.

---

# 45. Audit events

Lisa vähemalt:

```text
SUPPLIER.CREATED
SUPPLIER.UPDATED
SUPPLIER.DEACTIVATED

PURCHASE.INGESTED
PURCHASE.DRAFT_CREATED
PURCHASE.UPDATED
PURCHASE.REVIEWED
PURCHASE.APPROVED
PURCHASE.POSTED
PURCHASE.REJECTED
PURCHASE.CORRECTED

PURCHASE.DOCUMENT_ATTACHED
PURCHASE.EXTRACTION_COMPLETED
PURCHASE.SUPPLIER_MATCHED
PURCHASE.DUPLICATE_DETECTED
```

Metadata:

```text
purchase_invoice_id
supplier_id
supplier_invoice_number
invoice_date
due_date
currency
subtotal
tax_total
total
journal_entry_id
source_type
```

No secrets.

---

# 46. Error IDs

Lisa vähemalt:

```text
SUP-001 SUPPLIER_NOT_FOUND
SUP-002 SUPPLIER_INACTIVE
SUP-003 SUPPLIER_MATCH_AMBIGUOUS

PUR-001 PURCHASE_NOT_FOUND
PUR-002 PURCHASE_NOT_EDITABLE
PUR-003 PURCHASE_HAS_NO_LINES
PUR-004 INVALID_PURCHASE_LINE
PUR-005 DUPLICATE_PURCHASE
PUR-006 APPROVAL_REQUIRED
PUR-007 APPROVER_NOT_ALLOWED
PUR-008 ACCOUNT_MAPPING_MISSING
PUR-009 TAX_MAPPING_MISSING
PUR-010 PURCHASE_IMMUTABLE
PUR-011 INVALID_SOURCE_DOCUMENT
PUR-012 INGESTION_FAILED

EINV-001 UNSUPPORTED_FORMAT
EINV-002 INVALID_XML
EINV-003 DUPLICATE_EXTERNAL_EVENT
EINV-004 MISSING_REQUIRED_FIELD

OCR-001 EXTRACTION_UNAVAILABLE
OCR-002 EXTRACTION_FAILED
```

Ära leki cross-tenant olemasolu.

---

# 47. RLS

Kõik tenant-owned purchases tabelid:

```text
RLS ENABLED
FORCE RLS
```

Testi:

```text
Tenant A supplier → Tenant B DENY
Tenant A purchase → Tenant B DENY
Tenant A lines → Tenant B DENY
Tenant A extraction → Tenant B DENY
Tenant A source document → Tenant B DENY
Tenant A approval → Tenant B DENY
Tenant A settings → Tenant B DENY
```

No tenant context:
fail-closed.

---

# 48. Tenant-aware composite FK

Kõik tenant-owned relationid composite FK-ga.

Näiteks:

```text
(tenant_id, supplier_id)
→ business_parties(tenant_id,id)

(tenant_id, purchase_invoice_id)
→ purchase_invoices(tenant_id,id)

(tenant_id, expense_account_id)
→ accounts(tenant_id,id)

(tenant_id, tax_code_id)
→ tax_codes(tenant_id,id)

(tenant_id, document_id)
→ documents(tenant_id,id)
```

Direct DB cross-tenant relation:
DENY.

---

# 49. Posted immutability

Runtime role direct SQL:

POSTED purchase invoice:

```text
UPDATE financial fields → DENY
DELETE → DENY
```

POSTED lines:

```text
UPDATE → DENY
DELETE → DENY
```

Journal linkage:

```text
tamper → DENY
```

Supplier snapshot:
immutable pärast postingut.

---

# 50. Reviewable fields

DRAFT/NEEDS_REVIEW puhul võib muuta:

```text
supplier
invoice number
dates
lines
tax codes
expense accounts
reference
IBAN
```

Audit vajalik vastavalt olulistele muudatustele.

---

# 51. Server-side totals

Ära usalda parsed/OCR/browser totals'i autoriteetse tõena.

Review/posting ajal arvuta:

```text
subtotal = sum line net
tax_total = sum line tax
total = subtotal + tax_total
```

Võrdle source invoice totals'iga.

Kui erinevus:
warning või block vastavalt tolerance policy'le.

---

# 52. Totals tolerance

Structured invoice puhul peaks expected total olema täpne.

OCR puhul võib extraction olla vigane.

Defineeri:

```text
source_total
computed_total
difference
```

Kui difference != 0:
NEEDS_REVIEW / deny posting.

Ära auto-balanceeri.

---

# 53. Decimal / rounding

Kasuta sama v0.5/v0.6 money policy't:

```text
NUMERIC
decimal.js / strings
currency minor units
no JS float
```

Testi:

```text
0.1 + 0.2
fractional quantity
many small lines
multiple tax rates
credit note negative/positive semantics
```

---

# 54. API minimaalne

Näiteks:

```text
GET/POST/PATCH /api/v1/suppliers
GET /api/v1/suppliers/:id

GET/POST /api/v1/purchases
GET/PATCH /api/v1/purchases/:id

POST /api/v1/purchases/:id/review
POST /api/v1/purchases/:id/approve
POST /api/v1/purchases/:id/post
POST /api/v1/purchases/:id/reject
POST /api/v1/purchases/:id/correct

POST /api/v1/purchases/import
POST /api/v1/purchases/:id/documents
GET /api/v1/purchases/:id/documents

GET/PATCH /api/v1/purchase-settings
```

Kui approval auto-postib:
eraldi `/post` endpoint võib olla ainult permission-based/manual flow.

---

# 55. Import endpoint security

Upload/import:

- auth
- CSRF
- permission
- tenant membership
- size limit
- MIME/magic
- XML parser hardening
- RLS
- inbox idempotency

Ära võta tenant_id autoriteedina body seest.

---

# 56. Desktop UI – Purchases

Sidebar:

```text
Purchases
 ├ Purchase invoices
 ├ Suppliers
 └ Import / Inbox
```

Desktop primary.

---

# 57. Purchase invoice list

Table:

```text
Supplier | Invoice | Invoice date | Due date | Total | Status | Source | Actions
```

Filters:

```text
status
supplier
date range
source
needs review
due date
```

Pagination.

---

# 58. Purchase review/editor

Wide desktop form:

Header:

```text
Supplier
Invoice number
Invoice date
Due date
Currency
Reference
IBAN
Source
```

Lines:

```text
Description | Qty | Unit price | Expense account | Tax | Net | Tax | Total
```

Side panel või section:

```text
Source document preview
Extraction confidence/source
Duplicate warnings
```

---

# 59. Document preview

PDF/JPG/PNG puhul:
kasuta turvalist authitud preview/download flow'd.

Ära tee object storage public.

Kui inline PDF preview:
CSP peab säilima.

---

# 60. Extraction UX

Näita kasutajale, mis tuli:

```text
Structured XML
OCR
Manual
```

Kui confidence olemas:
näita seda mõõdukalt.

Näiteks:

```text
Invoice number  98% confidence
```

Aga ärge kasutage confidence'i final approval decisioni autoriteedina.

---

# 61. Approval UI

Button:

```text
Approve
```

Kui separate approver nõutud ja current user on creator:
disabled/deny backend.

UI peab selgelt näitama:

```text
Created by
Reviewed by
Approved by
Posted
```

---

# 62. Posted purchase view

Read-only.

Näita:

```text
supplier snapshot
invoice metadata
source document
lines
totals
journal link
approval history
audit
correction action
```

No Edit.

---

# 63. Inbox UI foundation

Lisa vähemalt lihtne:

```text
Purchases / Inbox
```

Näita:

```text
Received | Source | Supplier | Invoice | Amount | Status
```

Status:

```text
Processed
Needs review
Failed
Duplicate
```

Ära ehita veel operator dashboard'i.

---

# 64. E-invoice sample fixtures

Testides lisa sanitized fixtures:

```text
Finvoice
PEPPOL
TEAPPSXML
```

Ära kasuta päris klientide arveid.

Fixture sisaldab:

- supplier
- invoice id
- dates
- lines
- VAT
- total
- reference

---

# 65. Parser security tests

Kohustuslik:

```text
XXE
DTD
entity expansion
malformed XML
oversized XML
unexpected namespace
duplicate elements
missing required totals
invalid decimal
invalid date
```

Parser ei tohi lugeda local file/network resource'i.

---

# 66. OCR security

Kui OCR provider olemas:
input ainult storage providerist pärast upload validationit.

OCR output:
untrusted input.

Schema validate kõik extracted väärtused.

Ära lase OCR textil saada SQL/HTML/filename/path autoriteediks.

---

# 67. HTML/XSS

Supplier names, descriptions, OCR text, XML text võivad sisaldada hostile HTML.

Frontend:

```text
escape by default
no dangerous innerHTML
```

PDF/document preview ei tohi XSS-i tuua.

Testi vähemalt script-like values.

---

# 68. Concurrency / idempotency tests

Kohustuslik:

## External event duplicate

```text
same event 100 parallel times
→ 1 purchase invoice
```

## Approve race

```text
same invoice
20 parallel approve
→ exactly one approval transition
```

## Post race

```text
same approved invoice
20 parallel post
→ one journal
→ one POSTED transition
```

## Approve/post race

Kui auto-post:
üks deterministlik financial effect.

## Correction race

```text
same posted invoice
20 parallel correction/reversal
→ one correction effect
```

---

# 69. Accounting linkage invariant

Purchase:

```text
purchase_invoices.accounting_journal_entry_id
```

Üks purchase invoice:
max üks active primary posting journal.

Journal:

```text
source_type = PURCHASE_INVOICE
source_id = purchase_invoice_id
```

Correction/reversal:
eraldi source/linkage.

Duplicate retry:
ei tohi luua uut journalit.

---

# 70. Trial balance regression

Pärast purchase postingut:

```text
trial balance still balanced
```

Test sample:

```text
D Expense 1000
D Input VAT 240
C AP 1240
```

Total debit = total credit.

---

# 71. Purchase credit regression

Kui supplier credit note foundation implementeeritud:

```text
original + full supplier credit = 0
```

Kui correction reversal:
net effect samuti 0.

---

# 72. Permissions hostile tests

Testi:

```text
Viewer approve → DENY
Viewer post → DENY
Employee without permission post → DENY
Creator approve when separation required → DENY
Tenant A approve Tenant B → DENY
Tenant A attach document Tenant B purchase → DENY
```

---

# 73. Direct DB RLS tests

Runtime role otse:

```text
no tenant context → 0/deny
Tenant A → only A
Tenant B → only B
cross-tenant INSERT → deny
cross-tenant FK → deny
tenant_id update → deny
```

Kõigi v0.7 tenant-owned tabelite kohta.

---

# 74. Upgrade migration test

Kohustuslik:

```text
fresh DB → v0.7 PASS
v0.6 production-like snapshot → v0.7 PASS
```

Kontrolli, et säilivad:

```text
users
tenants
documents
audit
accounting
sales
sales PDFs
```

---

# 75. Backup/restore

Enne production deploy'd:

```text
DB backup
DB restore isolated
object backup
object restore/hash
```

Kõik PASS.

Kui purchase source documentid productionis olemas:
restore test peab kontrollima vähemalt ühe purchase source document SHA-256.

---

# 76. CI

CI peab jooksutama:

```text
lint
typecheck
auth regression
RLS regression
platform regression
accounting regression
sales regression
purchase unit
purchase integration
parser tests
XML security tests
purchase RLS/security
purchase concurrency/idempotency
document tests
Playwright
production build
npm audit
```

---

# 77. Documentation

Loo/uuenda:

```text
docs/PURCHASES.md
docs/PURCHASE_LIFECYCLE.md
docs/PURCHASE_INGESTION.md
docs/EINVOICE_ADAPTERS.md
docs/PURCHASE_APPROVAL.md
docs/PURCHASE_ACCOUNTING.md
docs/OCR_EXTRACTION.md

ARCHITECTURE.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
DEPLOYMENT.md
docs/ERROR_IDS.md
```

ADR-id vajadusel:

```text
purchase lifecycle
e-invoice canonical model
approval/posting boundary
duplicate/idempotency model
OCR/extraction trust model
```

Kasuta järgmisi vabu ADR numbreid repo tegeliku seisu järgi.

---

# 78. Production deploy gate

Deploy ainult kui:

```text
v0.6 regression                PASS
fresh v0.7 migration           PASS
v0.6→v0.7 upgrade              PASS
supplier model                 PASS
purchase lifecycle             PASS
document linkage               PASS
Finvoice parser                PASS
Peppol adapter                 PASS
TEAPPSXML adapter              PASS
XML hostile tests              PASS
OCR/manual review foundation   PASS
supplier matching              PASS
duplicate detection            PASS
approval                       PASS
separation of duties           PASS
purchase posting               PASS
accounting linkage             PASS
posted immutability            PASS
external idempotency           PASS
approve race                   PASS
post race                      PASS
correction race                PASS
purchase RLS                   PASS
Playwright                     PASS
backup/restore                 PASS
npm audit                      PASS
```

---

# 79. Production migration

Enne:

```text
backup PASS
restore PASS
```

Seejärel:

```text
migrate
verify schema
verify RLS
verify grants
verify v0.6 sales/accounting untouched
```

Ära productionis destructive down migrationit.

---

# 80. Production smoke

Kasuta QA tenant'i ja generated/sanitized test invoice't.

Flow:

```text
create/activate supplier
upload test PDF või import test Finvoice
verify document SHA-256
create/match purchase invoice
review
set expense account + tax code
approve
post
verify journal
verify trial balance balanced
verify source document link
attempt posted edit → DENY
attempt duplicate import → no duplicate purchase/journal
cross-tenant purchase read → DENY
cross-tenant source document → DENY
```

Kui supplier credit/correction valmis:
testi ka net effect.

---

# 81. Production e-invoice smoke

Kui adapterid on upload-fixture põhised:

```text
Finvoice fixture import → PASS
PEPPOL fixture import → PASS
TEAPPSXML fixture import → PASS
```

Ära vaja päris operaatori credential'i gate PASS jaoks.

Kui real operator integration pole implementeeritud:
dokumenteeri selgelt foundation-only.

---

# 82. Existing services

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

# 83. Public production security

Tilivo on internet-facing.

Ära lisa:

- public purchase document path
- unauthenticated import endpoint
- XML debug dump public route
- OCR raw debug endpoint
- test fixtures production endpoint
- raw SQL endpoint
- production bypass
- email token exposure

---

# 84. v0.7 mini security/accounting review

Enne gate PASS-i kontrolli:

```text
duplicate supplier invoice
duplicate external event
cross-tenant supplier leak
cross-tenant purchase leak
cross-tenant document leak
XML XXE
XML entity expansion
parser type confusion
OCR/XSS hostile text
approval bypass
separation-of-duties bypass
double posting
posted mutation
tax/account mapping mismatch
unbalanced journal
audit integrity regression
worker duplicate processing
```

CRITICAL/HIGH = 0 open.

---

# 85. Git

Tee loogilised commitid.

Näiteks:

```text
feat: add supplier capability and purchase domain
feat: add purchase document ingestion
feat: add canonical e-invoice adapters
feat: add purchase review and approval workflow
feat: post approved purchases to accounting core
feat: add purchase desktop ui
test: add purchase idempotency and parser security coverage
docs: document Tilivo purchase workflow
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

# 86. Stop conditions

Peata ja küsi ainult päris blockeriga:

- backup FAIL
- restore FAIL
- migration data-loss risk
- RLS cross-tenant leak
- parser security issue, mida ei saa ohutult lahendada
- duplicate external invoice võib tekitada mitu financial effect'i
- approval/post race võib tekitada double journal'i
- posted purchase mutation bypass
- accounting journal ei balansseeru
- production migration ohtlik
- muu serveriteenus saaks kahjustada
- päris external operator credential/user approval on vältimatult vajalik

Need EI OLE blockerid:

- tööpakett on suur
- UI on veel tegemata
- testid on veel tegemata
- operator API pole veel ühendatud, kui adapter foundation töötab fixture/importiga
- OCR provider on Noop, kui manual review töötab
- järgmine samm oleks...
- ühe turn'i pikkus

---

# 87. Final report

Anna lõpus täpne raport.

## 1. Suppliers

```text
Supplier capability:
CRUD:
Customer+supplier same party:
Defaults:
RLS:
```

## 2. Purchase lifecycle

```text
Ingest:
Draft/review:
Approve:
Post:
Reject:
Correction:
Immutable posted:
```

## 3. Documents / extraction

```text
PDF/JPG/PNG:
Document linkage:
SHA-256:
Confirmed immutable:
OCR provider:
Extraction fields:
Confidence/source:
```

## 4. E-invoice

```text
Canonical model:
Finvoice:
PEPPOL:
TEAPPSXML:
Inbox idempotency:
XML security:
```

## 5. Duplicate handling

```text
External event duplicate:
Supplier invoice duplicate:
100 retry:
Duplicate journal:
```

## 6. Approval

```text
Review:
Approval:
Separate approver:
Race:
Audit:
```

## 7. Accounting

```text
Expense:
Input VAT:
AP:
Journal linkage:
Trial balance:
Tax snapshot:
Correction net effect:
```

## 8. RLS/security

```text
Supplier:
Purchase:
Lines:
Extraction:
Documents:
Approval:
Settings:
Cross-tenant:
Posted mutation:
```

## 9. UI

```text
Suppliers:
Purchase list:
Review/editor:
Document preview:
Inbox:
Approval:
Posted read-only:
Desktop:
Mobile:
```

## 10. Tests

Täpsed käsud ja pass counts.

## 11. Production

```text
Backup:
Restore:
Migration:
DB:
API:
Web:
Worker:
HTTPS:
Purchase smoke:
E-invoice fixture smoke:
Journal smoke:
Cross-tenant deny:
```

## 12. Existing services

PASS/FAIL.

## 13. GitHub

```text
repo:
branch:
latest commit:
push:
working tree:
```

## 14. Open risks

Kõik MEDIUM/LOW/INFO.

## 15. Final gate

Kirjuta üks:

```text
V0.7 PURCHASES GATE: PASS
```

või:

```text
V0.7 PURCHASES GATE: FAIL
```

Kui PASS:

```text
STOP – v0.8 Banking ei alusta.
```

Kui FAIL:
näita ainult päris tehnilised blockerid.

---

# 88. Alusta nüüd

```text
Read docs/repo
→ preflight
→ backup/restore
→ purchase schema design
→ migrations
→ supplier capability
→ purchase lifecycle
→ source document linkage
→ canonical invoice model
→ Finvoice parser
→ PEPPOL adapter
→ TEAPPSXML adapter
→ XML hostile tests
→ OCR/extraction foundation
→ supplier matching
→ duplicate detection/idempotency
→ review workflow
→ approval workflow
→ accounting posting
→ correction/reversal foundation
→ permissions/audit/error IDs
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
→ V0.7 PURCHASES GATE
→ STOP
```

Kõige tähtsamad nõuded:

> **Structured e-invoice, OCR ja uploaded document on sisend; lõplik accounting truth tekib alles review/approval/posting workflow kaudu.**

> **Sama incoming invoice retry ei tohi kunagi tekitada duplicate purchase invoice'i ega duplicate journal entry't.**

> **POSTED purchase invoice ja kinnitatud source document history on immutable.**

> **Purchase posting kasutab ainult v0.5 controlled accounting engine'it.**

> **v0.7 ei tee veel makseid ega pangasobitamist – need tulevad v0.8/v0.9.**
