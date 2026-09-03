# Raamatupidamise SaaS – ARCHITECTURE v2.0

## 1. Toote eesmärk

Luua **lihtne, modulaarne, automatiseeritud ja mitmekeelne Soome väikeettevõtte raamatupidamise SaaS**, mida saab alguses kasutada sinu enda ettevõttes ja hiljem müüa teistele ettevõtjatele.

Esimene täielikult toetatud country profile:

**Finland / FI**

Hiljem:

**EE → SE → muud EL riigid.**

Toote eesmärk ei ole teha olemasolevast raamatupidamisprogrammist suuremat koopiat, vaid vähendada kasutajalt nõutavat käsitööd.

Tüüpiline kasutaja peaks nägema:

> 3 ostuarvet vajavad kontrolli  
> 1 dokumendil puudub tõend  
> Augusti ALV on valmis  
> 2 kliendiarvet on tasumata  
> Pank ja pearaamat klapivad

mitte 200 raamatupidamiskontot, mida ta iga päev käsitsi haldama peab.

---

## 2. Arhitektuuri põhimõte: modulaarne monoliit

Alguses **ei tee mikroteenuseid**.

Teeme:

```text
Web frontend
      │
      ▼
Backend API
 ├── Identity
 ├── Tenants
 ├── Accounting
 ├── Sales
 ├── Purchases
 ├── Banking
 ├── Payments
 ├── Tax
 ├── Payroll
 ├── Documents
 ├── Automation
 ├── AI
 └── SaaS Billing

      │
      ├── PostgreSQL
      ├── Object Storage
      ├── Queue / Worker
      └── External adapters
```

Moodulid on koodis rangelt eraldatud, kuid töötavad esialgu ühes backendis.

See annab:

- lihtsama deploy;
- lihtsama debugimise;
- lihtsamad DB-transaktsioonid;
- vähem servereid;
- väiksemad kulud;
- lihtsama arenduse ühe või paari arendajaga.

Kui tulevikus näiteks AI, OCR või pangaprotsessor muutub suureks eraldi teenuseks, saab selle mooduli hiljem eraldada.

---

## 3. Mittekaubeldavad invariandid

Need lähevad `ARCHITECTURE.md` algusesse.

### I

**Tenant A ei saa mitte mingil juhul Tenant B andmeid.**

### II

**Postitatud finantskanne on immutable.**

Seda ei muudeta ega kustutata.

Viga parandatakse:

```text
original entry
+
reversal/correction entry
```

### III

Iga postitatud journal entry:

```text
SUM(debit) == SUM(credit)
```

Tasakaalustamata kannet ei saa postitada.

### IV

Finantssündmus ja selle raamatupidamiskanne tekivad ühe kontrollitud protsessina.

Mitte:

```text
Create invoice

... kolm nädalat hiljem ...

Create accounting entry
```

vaid:

```text
Issue invoice
      ↓
Journal entry
      ↓
COMMIT
```

### V

Kõik välised sündmused on **idempotentsed**.

### VI

Kõik oluline on **auditeeritav**.

### VII

AI ei arvuta deterministlikke finantsreegleid.

ALV, journal posting, summad, kursivahed jne teeb **deterministlik programmikood**.

AI aitab:

- klassifitseerida;
- otsida;
- selgitada;
- soovitada;
- tuvastada anomaaliaid.

### VIII

Country rules on versioonitud.

Ei tehta kümneid või sadu juhuslikke `if (country === "FI")` harusid üle kogu koodi.

---

## 4. Keskkonnad

Kolm täiesti eraldi keskkonda.

### DEV

Arendus ja testandmed.

### STAGING

Productioniga võimalikult sarnane testkeskkond.

### PROD

Päris kliendid.

Kõigil on eraldi:

- PostgreSQL;
- secrets;
- API võtmed;
- object storage;
- encryption keys;
- e-mail konfiguratsioon;
- integratsioonide credentials.

---

## 5. API

API tuleb kohe versioneerida:

```text
/api/v1/auth
/api/v1/companies
/api/v1/invoices
/api/v1/banking
/api/v1/accounting
```

Lisaks:

```text
OpenAPI specification
```

Välistele integratsioonidele tulevikus eraldi API keys/OAuth permissions.

Webhookid samuti versioneeritakse.

---

## 6. Multi-tenant

Põhimudel:

```text
tenant
company
user
membership
role
permission
```

Üks kasutaja võib kuuluda mitmesse ettevõttesse.

Näiteks:

```text
Jaak
 ├── Company A → Owner
 ├── Company B → Accountant
 └── Company C → Viewer
```

Kõigil ettevõtte andmetel on:

```text
tenant_id
```

---

## 7. PostgreSQL RLS

Kasutame võimalusel PostgreSQL Row Level Security't.

Näiteks request:

```text
Authenticated user
      ↓
Resolve tenant
      ↓
DB transaction
      ↓
SET LOCAL app.tenant_id = ...
      ↓
Query
```

Oluline detail: connection pool'i tõttu ei tohi tenant context jääda järgmisele requestile külge.

Automaatne security test:

```text
Login Tenant A

GET /api/v1/invoices/<Tenant-B-ID>

EXPECTED:
404 / 403

NEVER:
Tenant B data
```

---

## 8. Identity ja autentimine

Esimene valmis kasutajamoodul:

- registreerimine;
- e-mail confirmation;
- login;
- logout;
- password reset;
- 2FA;
- remember me 30 päeva;
- session management;
- device/session list;
- remote logout;
- login history.

2FA esimene variant:

**TOTP authenticator**

Hiljem:

**Passkeys / WebAuthn**

Recovery codes salvestatakse turvaliselt, mitte plaintextina.

---

## 9. Login security

Lisame kohe:

- rate limiting;
- brute-force protection;
- progressive delays;
- credential stuffing protection;
- session rotation;
- secure HttpOnly cookies;
- SameSite;
- CSRF protection;
- suspicious login detection.

Admin ja tundlikud finantsõigused võivad nõuda tugevamat autentimist.

---

## 10. Õigused

Rollidest üksi ei piisa.

Seetõttu:

```text
invoice.read
invoice.create
invoice.issue
invoice.credit

purchase.approve

bank.read
bank.reconcile

payment.create
payment.approve
payment.submit

accounting.read
accounting.post
period.close
period.reopen

payroll.read
payroll.run
payroll.submit
```

Role on lihtsalt permission'ite kogum.

---

## 11. Andmetüüpide põhireeglid

### Raha

Mitte kunagi JavaScript `float`.

DB:

```text
NUMERIC / DECIMAL
```

Igal rahasummal on valuuta.

```text
amount
currency_code
```

### Aeg

Tehnilised timestamp'id:

```text
UTC
```

Raamatupidamiskuupäev:

```text
business_date
```

eraldi.

See väldib olukorda, kus UTC südaöö muudab Soome tehingu kogemata järgmise päeva tehinguks.

---

## 12. Accounting Core

See on kogu süsteemi süda.

Põhitabelid:

```text
chart_of_accounts
accounts

fiscal_years
accounting_periods

journal_entries
journal_lines

tax_codes

currencies
fx_rates
```

---

## 13. Journal entry lifecycle

Journal entry võib olla:

```text
DRAFT
POSTED
REVERSED
```

`DRAFT` võib muuta.

`POSTED` ei muudeta.

Parandus:

```text
POSTED entry #123
       ↓
REVERSAL entry #456
       ↓
CORRECT entry #457
```

Kõik kolm jäävad ajalukku.

---

## 14. Source linkage

Journal entry peab teadma, kust ta tuli.

Näiteks:

```text
source_type = SALES_INVOICE
source_id   = invoice_uuid
```

või:

```text
source_type = BANK_TRANSACTION
```

Seetõttu saab alati liikuda:

```text
Pearaamatu kanne
      ↕
Algdokument
```

---

## 15. Valuuta ja FX

Igal ettevõttel on:

```text
base_currency = EUR
```

Arve võib olla:

```text
transaction_currency = USD
```

Salvestame:

```text
fx_rate
fx_rate_date
fx_source
base_amount
transaction_amount
```

Kui USD arve väljastatakse kursiga A ja makstakse kursiga B:

```text
FX_GAIN
```

või

```text
FX_LOSS
```

tekib automaatselt pearaamatusse.

Hiljem toetame ka perioodilist valuutapositsioonide ümberhindlust.

---

## 16. Country Rule Engine

Kõik riigispetsiifilised reeglid versioonitakse.

Näiteks:

```text
FI / VAT / STANDARD / 2024-09-01 → 25.5%
FI / VAT / REDUCED  / 2026-01-01 → 13.5%
```

Reegleid ei hardcode'ita rakenduse source code'i.

---

## 17. Finnish Requirements Registry

Teeme eraldi dokumendi:

```text
FINLAND_REQUIREMENTS.md
```

Iga nõue saab:

```text
ID
source
effective_from
effective_to
rule_version
implementation
tests
```

Näiteks:

```text
FI-VAT-001
FI-INVOICE-004
FI-PAYROLL-009
FI-RETENTION-002
```

Kui seadus muutub, on selge, miks mingi reegel koodis olemas on.

---

## 18. Soome kontoplaan

Uue FI ettevõtte loomisel saab kasutaja starter chart of accounts'i.

Kasutaja ei pea nullist 200 kontot looma.

Samas kontoplaan ei ole hardcoded.

Tenant saab seda kohandada.

---

## 19. Contacts

Ühine contact engine:

```text
business_parties
```

Sest sama firma võib olla nii klient kui tarnija.

Andmed:

- nimi;
- Y-tunnus;
- VAT ID;
- aadress;
- e-post;
- telefon;
- keel;
- maksetingimus;
- IBAN;
- e-arve aadress;
- operaator;
- valuuta.

---

## 20. Müügiarved

Arve olekud:

```text
DRAFT
ISSUED
PARTIALLY_PAID
PAID
CREDITED
CANCELLED
```

`DRAFT` ei ole veel ametlik raamatupidamisdokument.

Alles `ISSUE` hetkel:

1. eraldatakse arvenumber;
2. lukustatakse vajalik arvesisu;
3. arvutatakse maksud;
4. luuakse journal entry;
5. tehakse DB COMMIT;
6. luuakse saatmisülesanne.

---

## 21. Arvenumbrite atomaarsus

Teeme näiteks:

```text
invoice_series
tenant_id
year
prefix
next_number
```

Arve väljastamisel:

```text
BEGIN

LOCK invoice_series

number = next_number
next_number++

INSERT invoice

INSERT journal_entry

COMMIT
```

Kahe samaaegse kasutaja puhul ei saa mõlemad sama numbrit.

Nummerdus määratakse **issue**, mitte draft'i loomisel.

---

## 22. Krediitarved

Väljastatud arvet ei hakata lihtsalt ümber kirjutama.

Parandus:

```text
Original invoice
      ↓
Credit note
      ↓
New/correct invoice
```

Krediitarve teeb automaatselt vastupidise raamatupidamiskande ning korrigeerib VAT-i.

---

## 23. Soome viitenumber

Payment Reference on eraldi komponent:

```text
PaymentReferenceProvider
```

Toetame:

- Finnish domestic reference;
- RF Creditor Reference.

Generator ja validator on eraldi testitud moodul.

---

## 24. E-arved

Teeme canonical internal invoice modeli:

```text
CanonicalInvoice
```

ja adapterid:

```text
FinvoiceAdapter
PeppolAdapter
TEAPPSXMLAdapter
```

Esimene praktiline integratsioon võib olla e-arve operaatori kaudu.

---

## 25. Dokumendid

Kõik uploadid lähevad object storage'i.

Näiteks:

```text
document
document_version
document_hash
```

Kinnitamisel salvestatakse:

```text
SHA-256
mime_type
size
uploaded_at
confirmed_at
confirmed_by
```

Kinnitatud lähtedokumenti ei kirjutata üle.

Kui kasutaja lisab uue:

```text
Version 1
Version 2
```

Mõlemad säilivad.

---

## 26. Ostuarved

Sisend:

- Finvoice;
- Peppol;
- PDF;
- JPG;
- PNG;
- e-mail;
- upload;
- API.

Pipeline:

```text
Document received
      ↓
Parsing / OCR
      ↓
Vendor recognition
      ↓
AI/rules suggestion
      ↓
User check if needed
      ↓
Approval
      ↓
Journal posting
```

---

## 27. OCR ja AI ei ole tõeallikas

Kui OCR loeb summa madala confidence'iga, ei postita süsteem seda pimesi.

Dokumendi parser annab:

```text
field
value
confidence
source_region
```

Kasutaja saab vajadusel kontrollida.

---

## 28. Pangamoodul

Canonical model:

```text
BankTransaction
```

Sisendadapterid:

```text
CAMT.053
CAMT.054
CSV
OpenBanking
legacy formats when needed
```

Kõik saavad lõpuks ühesuguseks sisemiseks `BankTransaction` objektiks.

---

## 29. Pangatehingute idempotentsus

Pank võib sama sündmuse mitu korda saata.

Seetõttu:

```text
provider
external_transaction_id
```

on unique.

Sama sündmus uuesti:

```text
Already processed
→ do not create transaction
→ do not create journal entry
```

---

## 30. Inbox / Outbox pattern

### Inbox

Välised sündmused:

```text
webhook
bank event
e-invoice
payment status
```

registreeritakse enne töötlemist.

### Outbox

Kui meie süsteem peab midagi välja saatma:

```text
invoice created
↓
DB commit
↓
outbox_event
↓
worker
↓
send e-mail/e-invoice
```

Kui e-arve operaator on maas, raamatupidamiskanne ei kao.

Worker proovib hiljem uuesti.

---

## 31. Bank matching

Sobitusmootor kasutab:

- viitenumbrit;
- summat;
- IBAN-i;
- maksja nime;
- kuupäeva;
- arvenumbrit.

Tulemuseks:

```text
candidate match
confidence
reasons
```

Näiteks:

```text
99.7 %

Reference exact match
Amount exact match
IBAN known customer
```

---

## 32. Bank reconciliation

Matching ja reconciliation on **kaks eri asja**.

Matching:

> kelle arvele kuulub see tehing?

Reconciliation:

> kas pangaväljavõtte saldo ja pearaamat klapivad?

Vajame:

```text
opening_balance
transactions
closing_balance
ledger_balance
difference
```

Ideaalne:

```text
Difference: 0.00 €
```

---

## 33. Maksed

Töövoog:

```text
Purchase invoice
     ↓
Approved
     ↓
Payment proposal
     ↓
Payment approval
     ↓
Bank
     ↓
Payment confirmation
```

Suuremates ettevõtetes:

```text
Creator != Approver
```

ehk four-eyes principle.

---

## 34. ISO 20022

Payment adapter peab toetama ISO 20022 payment initiation formaate.

Ei hardcode'ita ühte XML versiooni.

Näiteks:

```text
PaymentFormatAdapter
 ├── pain.001.001.03
 └── pain.001.001.09
```

vastavalt pangale.

---

## 35. VAT Engine

VAT code koosneb vähemalt:

```text
country
type
rate
effective_from
effective_to
reporting_mapping
```

Näiteks:

```text
FI_STANDARD
FI_REDUCED
FI_ZERO
FI_EXEMPT
FI_REVERSE_CHARGE_CONSTRUCTION
FI_EU_GOODS
FI_EU_SERVICES
FI_IMPORT
```

---

## 36. Ehitussektori reverse VAT

Soome ehitussektori pöördkäibemaks ei ole lihtsalt `VAT = 0`, vaid eraldi tax treatment.

See peab olema eraldi reeglina tax engine'is.

---

## 37. VAT-perioodid

Ärme hardcode'i:

```text
every month
```

Ettevõtte tax profile sisaldab:

```text
VAT period:
MONTH
QUARTER
YEAR
```

---

## 38. Accounting periods

Periood:

```text
OPEN
SOFT_CLOSED
CLOSED
```

Suletud perioodi ei saa tavaliselt enam postitada.

Reopen:

- eraldi permission;
- põhjus;
- audit;
- vajadusel 2FA/re-authentication.

---

## 39. Põhiaruanded

Vähemalt:

- Profit & Loss;
- Balance Sheet;
- General Ledger;
- Account Ledger;
- Trial Balance;
- Accounts Receivable;
- Accounts Payable;
- VAT report;
- Bank reconciliation;
- audit trail.

---

## 40. Tilinpäätös / majandusaasta lõpetamine

Moodul:

```text
Fiscal year closing
Closing entries
Balance sheet
P&L
Notes/data package
Financial statements archive
```

Lisame deadline engine'i, et tähtajad oleksid süsteemis jälgitavad.

---

## 41. Ettevõtte tuludeklaratsioon

FI Oy profile peab teadma corporate tax reporting deadline'i.

Esimeses etapis:

```text
prepare
validate
export
```

Hiljem võimalusel API submission.

---

## 42. Payroll

Payroll on eraldi domain.

```text
employees
employment
pay_runs
pay_items
benefits
expense_reimbursements
per_diems
mileage
withholdings
employer_costs
```

Kõik määrad on **effective-dated**.

Näiteks päevaraha määra ei kirjutata:

```text
const PER_DIEM = 52;
```

vaid:

```text
FI / PER_DIEM / effective_from / effective_to / value
```

---

## 43. Tulorekisteri

Kui payroll kuulub päriselt kommertstoote FI versiooni, peab süsteem suutma vajalikud raportid korrektselt moodustada ja lõpuks tehnilise liidese kaudu esitada.

---

## 44. Reeglimootor enne AI-d

Teeme:

```text
Rules Engine
```

Näiteks:

```text
IF
vendor = "Elisa Oy"
AND
historical_account = 6500
THEN
suggest account 6500
```

või:

```text
IF
reference_exact_match
AND
amount_exact_match
THEN
match invoice
```

Need asjad ei vaja LLM-i.

---

## 45. AI Assistant

AI tuleb struktureeritud tools-kihi peale.

Näiteks:

```text
get_unpaid_invoices()
get_monthly_revenue()
get_bank_difference()
find_missing_documents()
suggest_account()
explain_vat_entry()
```

AI-l pole otsest arbitrary SQL ligipääsu.

---

## 46. AI explainability

Iga AI soovitus sisaldab:

```text
Suggestion
Confidence
Reason
Evidence
```

Näiteks:

> Konto 6500 – Telefonikulud  
> Soovitatud, sest sama tarnija viimased 11 kinnitatud arvet on kasutatud selle kontoga.

---

## 47. AI automaatika tasemed

### Level 1

Read only.

### Level 2

Suggestions.

### Level 3

Kasutaja lubatud automatiseerimine.

### Level 4

Sensitive action.

Näiteks:

```text
Submit payment
Submit tax report
Pay payroll
```

vajavad eraldi kinnitust.

---

## 48. Audit trail

Igal tähtsal sündmusel:

```text
event_id
tenant_id
user_id
session_id
timestamp
action
resource_type
resource_id
before
after
trace_id
ip
user_agent
```

Näiteks:

```text
PURCHASE_INVOICE.APPROVED
```

---

## 49. Audit-logi muutmatus

Audit on append-only.

Admin saab:

```text
READ
```

mitte:

```text
UPDATE
DELETE
```

Kõrgema assurance'i jaoks võib hiljem kasutada:

- hash chain'i;
- WORM/object lock archive'i.

---

## 50. Error ID + Trace ID

Kasutaja näeb näiteks:

```text
Viga arve salvestamisel.

Error ID: INV-104
Trace ID: 01J...
```

Tugi otsib Trace ID ja näeb kogu sündmuste ahelat.

---

## 51. Structured logging

Kõik logid struktureeritud kujul.

Näiteks:

```json
{
  "level": "error",
  "tenant": "...",
  "module": "sales",
  "error_id": "INV-104",
  "trace_id": "...",
  "action": "issue_invoice"
}
```

Redaction toimub **enne logi kirjutamist**.

---

## 52. Logides keelatud

Mitte kunagi:

- password;
- TOTP secret;
- session token;
- recovery code;
- API secret;
- pangatunnused;
- täielikud tundlikud isikuandmed.

---

## 53. GDPR ja legal archive

Eristame:

```text
Account deletion
Soft delete
Legal retention
Legal archive
Anonymisation
```

Retention engine otsustab objekti tüübi järgi, millal midagi võib kustutada.

---

## 54. SaaS-i kliendi lahkumine

Subscription cancellation:

```text
ACTIVE
→ CANCELLED
→ READ_ONLY
→ EXPORT WINDOW
→ ARCHIVED
```

See ei tähenda:

```text
DELETE EVERYTHING
```

Samuti tuleb lepinguliselt selgeks teha, kas arhiveerimist pakub meie teenus või klient võtab seadusliku säilitamise enda hooleks pärast andmete eksporti.

---

## 55. Backup ja Disaster Recovery

Vähemalt:

- point-in-time DB recovery;
- encrypted DB backup;
- object storage versioning;
- off-site backup;
- backup monitoring.

Lisaks määrame:

```text
RPO
RTO
```

Esialgne siht võib olla näiteks:

```text
RPO <= 1 hour
RTO <= 4 hours
```

kuni infrastruktuur seda mõistlikult võimaldab.

---

## 56. Restore-test

Backup ei ole „working“, kuni seda pole taastatud.

Näiteks kord kuus:

```text
restore production backup
→ isolated environment
→ integrity tests
→ report
```

---

## 57. Import

Esimesed migratsioonivõimalused:

- CSV;
- Excel;
- customers;
- suppliers;
- open invoices;
- opening balances;
- bank transactions;
- documents ZIP.

Hiljem konkurentide adapterid.

---

## 58. Export

Klient saab alati välja:

- raamatupidamisandmed;
- arved;
- dokumendid;
- audit history;
- kontoplaani;
- aruanded.

Formaadid:

```text
CSV
Excel
PDF
ZIP
structured exports
```

---

## 59. SaaS Platform & Billing

See on **üks moodul**, mitte kaks dubleerivat peatükki.

```text
SaaSPlatform
 ├── Plans
 ├── Subscriptions
 ├── Billing
 ├── Trials
 ├── Entitlements
 ├── Usage
 └── SaaS Admin
```

Server kontrollib entitlement'i.

Frontend ei otsusta, kas kasutajal on õigus tasulist funktsiooni kasutada.

---

## 60. SaaS Billing ei ole sisemise MVP blokeerija

Eesmärk on saada enda firma süsteem võimalikult kiiresti päriselt tööle.

Seetõttu ei ehita me SaaS billingut enne, kui põhiline raamatupidamise töövoog töötab.

Billing arhitektuur on ette nähtud, aga realiseeritakse enne väliste klientide onboarding'ut.

---

## 61. Monitoring

Jälgime:

```text
HTTP errors
latency
DB health
DB locks
queue backlog
worker failures
bank sync
e-invoice failures
backup
disk
CPU
memory
login attacks
payment failures
```

---

## 62. Security

Vundamendis:

- TLS;
- encryption at rest;
- secrets management;
- secure cookies;
- CSP;
- CSRF;
- SQL injection protection;
- XSS protection;
- schema validation;
- upload malware scanning;
- dependency scanning;
- signed webhook validation.

Tundlikud väljad saab vajadusel krüpteerida eraldi application layer'is.

---

## 63. Incident Response

Kirjutame enne kommertskasutust:

```text
INCIDENT_RESPONSE.md
```

Sisaldab:

- incident classification;
- containment;
- credential rotation;
- evidence preservation;
- customer notification process;
- GDPR breach workflow;
- postmortem.

---

## 64. Testid

### Unit

- VAT;
- FX;
- reference numbers;
- journal rules;
- invoice numbering.

### Integration

- DB;
- RLS;
- posting;
- bank imports.

### E2E

- register;
- invoice;
- purchase;
- bank;
- VAT;
- period close.

### Security

- tenant escape;
- IDOR;
- role bypass;
- session attacks.

---

## 65. Accounting property tests

Näiteks genereerime tuhandeid juhuslikke stsenaariume ja kontrollime alati:

```text
total debit == total credit
```

Samuti:

```text
invoice total
==
net + tax
```

ja:

```text
reversal(original)
→ net accounting impact = 0
```

---

## 66. Concurrency test

Automaatne test:

```text
100 concurrent invoice issue requests
```

Kontroll:

```text
100 unique numbers
0 duplicates
correct journal entries
```

---

## 67. Idempotency test

Saada sama pangasündmus:

```text
100 times
```

Oodatav:

```text
1 bank transaction
1 journal effect
```

---

## 68. Accessibility

UI järgib vähemalt mõistlikke WCAG põhimõtteid.

Värv pole ainus signaal.

Näiteks mitte ainult punane, vaid:

```text
⚠ Arve vajab kontrolli
```

---

## 69. Disain

Stiil:

- valge;
- helehall;
- palju ruumi;
- professionaalne;
- vähe dekoratsiooni;
- väga selge infohierarhia.

Dashboard peaks olema rohkem:

```text
Tähelepanu vajab 4 asja
```

ja vähem:

```text
47 erinevat diagrammi
```

---

## 70. Arendusjärjekord – parandatud

> **Uuendatud 2026-09-03:** v0.1–v0.7 on ehitatud vastavalt allolevale tabelile. Alates **v0.7.5**
> (Business Registry Integration) kehtib uus plaan – vt [`ROADMAP.md`](ROADMAP.md). v0.7.5 jääb viimaseks
> "vana plaani" punktiks; alates v0.8 ehitatakse täisväärtuslikku Soome raamatupidamistarkvara (Accounting/ERP),
> mitte lihtsalt arvete programmi. Allolev tabel jääb ajalooliseks plaaniks.

| Versioon | Sisu |
|---|---|
| **v0.1** | Infrastructure, repo, CI/CD, DEV/STAGING/PROD, PostgreSQL, API v1, secrets, jobs, monitoring, backup |
| **v0.2** | Identity, email confirmation, login, 2FA, 30-day remember, sessions, rate limits |
| **v0.3** | Multi-tenant, memberships, roles, permissions, PostgreSQL RLS |
| **v0.4** | Audit, Trace ID, Error ID, documents, retention foundation, inbox/outbox |
| **v0.5** | Accounting Core, journal engine, periods, chart of accounts, country rules, tax codes, currencies, FX |
| **v0.6** | Contacts + Sales, invoice numbering, Finnish reference, PDF, journal posting |
| **v0.7** | E-invoice + Purchases + document ingestion + approval + journal posting |
| **v0.8** | Banking imports + matching + bank reconciliation |
| **v0.9** | Payments + approval + ISO 20022 |
| **v0.10** | FI VAT + reverse charge + reporting + period close |
| **v0.11** | Financial reports + fiscal year close + tilinpäätös foundation |
| **v0.12** | FI corporate tax reporting/export |
| **v0.13** | Payroll + per diem + mileage + Tulorekisteri |
| **v0.14** | Rules engine + AI assistant |
| **v0.15** | SaaS Billing + plans + entitlements + onboarding |
| **v0.16** | Migration tools + external customer onboarding |
| **v0.17** | Load testing, pentest, disaster recovery test, compliance review |
| **v1.0** | Commercial Finland release |

---

## 71. Väga oluline vahe-eesmärk

### INTERNAL ACCOUNTING BETA

See tekib umbes:

```text
v0.10
```

Selleks ajaks peaks enda ettevõte saama teha:

```text
müügiarved
+
ostuarved
+
dokumendid
+
pank
+
matching
+
journal entries
+
VAT
+
period close
```

Me **ei pea ootama commercial v1.0-ni**, enne kui programm saab enda ettevõttes juba raha säästa.

SaaS billing, täiuslik onboarding ja avalik müük võivad tulla hiljem.

---

## 72. Commercial v1.0 kriteeriumid

`v1.0` ei tähenda lihtsalt „feature list valmis“.

Release toimub siis, kui:

```text
tenant isolation PASS
accounting invariants PASS
backup restore PASS
payment idempotency PASS
invoice concurrency PASS
VAT test cases PASS
RLS security tests PASS
penetration test PASS
FI requirements review PASS
```

---

## 73. Tõe hierarhia

```text
Law / country rules
        ↓
Deterministic accounting engine
        ↓
Ledger
        ↓
Business modules
        ↓
Rules automation
        ↓
AI
```

Mitte:

```text
AI
↓
teeb kuidagi raamatupidamist
```

---

## 74. Raamatupidamisajaloo põhimõte

Raamatupidamisajalugu ei ole tavaline CRUD-andmebaas.

- Customeri nime võib muuta.
- Draft'i võib kustutada.
- Postitatud finantssündmust ei muudeta ega kustutata.
- Viga parandatakse uue finantssündmusega.

---

## 75. Edasine samm

Pärast selle arhitektuuri lukustamist tuleb teha eraldi:

```text
V0_1_TECHNICAL_SPEC.md
FINLAND_REQUIREMENTS.md
RLS_AND_TENANT_ISOLATION.md
INCIDENT_RESPONSE.md
```

Seejärel lukustada:

- tehnoloogiapinu;
- repo struktuur;
- PostgreSQL baasskeem;
- Docker/deploy;
- esimese sprindi konkreetsed ülesanded.
