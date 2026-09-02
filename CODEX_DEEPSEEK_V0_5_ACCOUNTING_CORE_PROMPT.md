# Codex / DeepSeek tööülesanne – Tilivo v0.5 Accounting Core

## Eesmärk

Tilivo v0.1 Infrastructure, v0.2 Identity, v0.3 Multi-Tenant + PostgreSQL RLS ja v0.4 Platform + Desktop UI on valmis, testitud ja production’is.

Viimane gate:

```text
V0.4 PLATFORM + DESKTOP UI GATE: PASS
```

Nüüd ehita **Tilivo v0.5 Accounting Core**.

See on esimene päris raamatupidamise mootori etapp.

Ära alusta veel:
- v0.6 Sales / müügiarved
- v0.7 Purchases
- v0.8 Banking
- v0.9 Payments
- v0.10 FI VAT reporting
- Payroll
- AI

v0.5 eesmärk on valmis saada tugev ja testitud pearaamatu tuum, mille peale järgmised moodulid hakkavad automaatselt kandeid looma.

Kõige tähtsamad invariandid:

> **Iga POSTED journal entry peab alati olema balansis: SUM(debit) = SUM(credit).**

> **POSTED journal entry ja journal line on muutumatud. Parandus tehakse reversal/correction entry kaudu, mitte olemasoleva kande muutmisega.**

> **Tenant A ei tohi näha ega muuta Tenant B accounting data't isegi application-layer vea korral. PostgreSQL RLS peab jääma teiseks turvakihiks.**

> **Money väärtustes ei kasutata JavaScript float'i. Kasuta Decimal/NUMERIC.**

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
- `docs/MULTI_TENANCY.md`
- `docs/RLS_SECURITY.md`
- `docs/AUDIT_MODEL.md`
- `docs/ERROR_IDS.md`
- kõik ADR-id
- kõik olemasolevad migrationid
- tenant transaction helper
- permission service
- audit service
- RLS testid
- CI
- server.md

Kontrolli:

```text
v0.2 auth regression          PASS
v0.3 RLS regression           PASS
v0.4 platform regression      PASS
production backup             PASS
restore test                  PASS
DB/API/Web/Worker health      PASS
```

Kui mõni FAIL:
paranda enne v0.5 alustamist.

---

# 2. v0.5 scope

v0.5 peab sisaldama vähemalt:

```text
chart_of_accounts / accounts
accounting_periods
fiscal_years
journal_entries
journal_lines
tax_codes
currencies
fx_rates
journal posting engine
journal reversal
period open/soft-close/close
source linkage
account balance/reporting query foundation
audit events
permissions
RLS
tests
desktop UI foundation
```

Ära ehita veel müügi- või ostuarve äriloogikat.

---

# 3. Accounting data model

Loo migrationitega vähemalt:

```text
accounts
fiscal_years
accounting_periods
journal_entries
journal_lines
tax_codes
currencies
fx_rates
```

Kõik tenant-owned tabelid:

```text
tenant_id NOT NULL
RLS ENABLED
FORCE RLS
```

Runtime role:

```text
BYPASSRLS = false
```

---

# 4. Accounts / Chart of Accounts

Tabel `accounts` vähemalt:

```text
id UUID
tenant_id UUID
code
name
type
subtype nullable
normal_balance
currency_code nullable
is_system
is_active
created_at
updated_at
```

Account types vähemalt:

```text
ASSET
LIABILITY
EQUITY
REVENUE
EXPENSE
```

Unique:

```text
(tenant_id, code)
```

Ära hardcode'i Soome kontoplaani rakendusloogikasse.

Seed foundation võib sisaldada Finland starter chart'i eraldi data/seed failina, kuid tenant peab saama kontoplaani hiljem muuta/laiendada.

System account'i kustutamine peab olema piiratud.

---

# 5. Account code

Account code käsitle stringina, mitte integerina.

Põhjus:
hilisemad riigid/kontoplaanid võivad vajada erinevat kodeerimist.

Validation:
- trim
- length
- unique tenant sees
- no dangerous control chars

Ära eelda ainult 4-kohalist numbrit.

---

# 6. Fiscal years

Tabel `fiscal_years` vähemalt:

```text
id
tenant_id
name
start_date
end_date
status
created_at
updated_at
```

Status näiteks:

```text
OPEN
CLOSED
```

Validation:

```text
start_date <= end_date
```

Tenant'i fiscal year'id ei tohi kattuda ilma teadliku põhjuseta.

Lisa overlap test.

---

# 7. Accounting periods

Tabel `accounting_periods` vähemalt:

```text
id
tenant_id
fiscal_year_id
name
start_date
end_date
status
closed_at
closed_by
reopened_at
reopened_by
reopen_reason
created_at
updated_at
```

Status:

```text
OPEN
SOFT_CLOSED
CLOSED
```

Reeglid:

```text
OPEN
→ posting allowed

SOFT_CLOSED
→ normal user posting denied
→ privileged override only if architecture explicitly allows

CLOSED
→ posting denied

reopen
→ separate permission
→ reason required
→ audit event
```

---

# 8. Journal entry

`journal_entries` vähemalt:

```text
id
tenant_id
entry_number
business_date
posting_date
description
status
source_type nullable
source_id nullable
currency_code
exchange_rate nullable
reversal_of_entry_id nullable
reversed_by_entry_id nullable
created_by
posted_by nullable
created_at
posted_at nullable
```

Status:

```text
DRAFT
POSTED
REVERSED
```

DRAFT võib olla mutable.

POSTED peab olema immutable.

REVERSED tähendab, et sellele on loodud reversal entry; originaalkannet ei muudeta sisuliselt ümber.

---

# 9. Journal lines

`journal_lines` vähemalt:

```text
id
tenant_id
journal_entry_id
line_number
account_id
description nullable
debit
credit
currency_code
foreign_amount nullable
exchange_rate nullable
tax_code_id nullable
created_at
```

Reeglid:

```text
debit >= 0
credit >= 0
not both > 0
not both = 0
```

Money:

```text
PostgreSQL NUMERIC
```

Ära kasuta JS Number'it summade autoriteetseks arvutuseks.

Kasuta decimal library't või DB numeric string handling'ut.

---

# 10. Balanced-entry invariant

POSTED entry:

```text
SUM(debit) == SUM(credit)
```

See invariant peab olema kaitstud rohkem kui ainult frontendiga.

Eelistus:

```text
service transaction validation
+
DB-level final protection
```

PostgreSQL CHECK ei saa lihtsalt multi-row summat kontrollida, seega kasuta vajadusel:

- deferred constraint trigger
- posting stored function
- controlled posting transaction

Vali turvaline lahendus ja dokumenteeri ADR-is.

Näiteks:

```text
ADR-0014-journal-posting-invariants.md
```

Testi hostile/direct DB path'i.

---

# 11. Controlled posting engine

Ära luba route'idel suvaliselt:

```text
UPDATE journal_entries SET status='POSTED'
```

Tee üks accounting posting service/funktsioon.

Näiteks:

```text
postJournalEntry(entryId, actor, tenantContext)
```

Posting peab ühes transaction'is:

1. lockima entry;
2. kontrollima tenant context'i;
3. kontrollima status = DRAFT;
4. kontrollima period OPEN;
5. kontrollima account'id active;
6. kontrollima currency;
7. kontrollima vähemalt 2 line'i;
8. kontrollima debit/credit;
9. kontrollima balance;
10. määrama entry number'i;
11. muutma POSTED;
12. salvestama posted_by/posted_at;
13. kirjutama audit event'i;
14. commit.

Kui üks samm failib:
ROLLBACK kõik.

---

# 12. Entry numbering

Journal entry number peab olema tenant-specific ja race-safe.

Näiteks:

```text
2026-000001
2026-000002
```

või muu dokumenteeritud formaat.

Number eraldatakse POSTING ajal, mitte draft loomisel.

Concurrency test:

```text
100 parallel posts
→ 100 unique entry numbers
→ 0 duplicate
```

Ära kasuta application-memory counterit.

Kasuta DB transaction/locking/sequence strategy't.

---

# 13. Posted immutability

POSTED entry/line puhul deny:

```text
UPDATE description
UPDATE business_date
UPDATE account_id
UPDATE debit
UPDATE credit
DELETE line
DELETE entry
```

Kaitse:

```text
application service
+
DB trigger/privilege
```

Direct runtime-role DB mutation peab samuti DENY.

Testi otseselt DB-st.

---

# 14. Reversal

Tee kontrollitud reversal flow.

Näiteks:

```text
reverseJournalEntry(entryId, reversalDate, reason)
```

Reversal entry:

- uus journal entry
- source link originaalile
- kõik debit/credit read vastupidiselt
- oma entry number
- posted kohe controlled posting flow kaudu
- original `reversed_by_entry_id`
- reversal `reversal_of_entry_id`

Net effect:

```text
original + reversal = 0
```

Property test kohustuslik.

Originaal POSTED kirje jääb alles.

---

# 15. Correction

V0.5 võib correction foundation olla:

```text
reverse original
→ create correct replacement draft/post
```

Ära loo silent edit'i.

Kui täis UI correction wizard pole vajalik:
service/API foundation piisab.

---

# 16. Source linkage

Journal entry peab toetama:

```text
source_type
source_id
```

Näiteks tulevikus:

```text
SALES_INVOICE
PURCHASE_INVOICE
BANK_TRANSACTION
PAYROLL
MANUAL
OPENING_BALANCE
```

v0.5-s implementeeri vähemalt:

```text
MANUAL
OPENING_BALANCE
```

Ära lisa veel source FK-sid tabelitesse, mida pole olemas.

Source linkage peab võimaldama hiljem navigeerida pearaamatust algdokumendini.

---

# 17. Manual journal entry

V0.5 peab lubama authorized kasutajal luua käsikande.

Flow:

```text
create draft
add/edit/remove lines
validate
post
```

Permissions näiteks:

```text
accounting.read
journal.create
journal.post
journal.reverse
period.manage
period.reopen
chart.manage
```

Viewer ei tohi postitada.

---

# 18. Opening balances

Lisa foundation opening balances jaoks.

Eelistus:

```text
source_type = OPENING_BALANCE
```

Opening balance peab samuti olema balanced journal entry.

Ära tee eraldi paralleelset accounting truth süsteemi.

Ledger on source of truth.

---

# 19. Tax codes

`tax_codes` vähemalt:

```text
id
tenant_id nullable/system-template strategy
code
name
country_code
rate
type
effective_from
effective_to
reporting_mapping nullable
is_active
```

Ära hardcode'i praegu FI VAT reporting loogikat.

v0.10 kasutab seda.

Rate peab olema effective-dated.

Tax code'i muutmine ei tohi muuta vana posted journal line'i ajaloolist tähendust.

Vajadusel journal line salvestab applied tax metadata snapshot'i või seosta immutable versioniga.

Disaini ettevaatlikult.

---

# 20. Currencies

`currencies` võib olla global/reference tabel.

Vähemalt:

```text
code ISO 4217
name
minor_units
is_active
```

Seed vähemalt:

```text
EUR
USD
GBP
SEK
NOK
DKK
```

Ära loo currency tenant-owned tabeliks, kui see on standard reference data.

Dokumenteeri global-vs-tenant distinction.

---

# 21. FX rates

`fx_rates` vähemalt:

```text
id
tenant_id
base_currency
quote_currency
rate
rate_date
source
created_at
```

Unique mõistlikult:

```text
tenant_id + base + quote + rate_date + source
```

Rate:

```text
NUMERIC
> 0
```

Ära fetch'i v0.5-s välisest providerist, kui adapterit pole vaja.

Manual/import foundation piisab.

---

# 22. Base currency

Company `base_currency` on juba v0.3-s olemas.

Accounting Core peab seda kasutama.

Kui journal entry currency != company base currency:
nõua exchange rate'i.

Kõik base-currency ledger amounts peavad olema deterministlikult arvutatavad ja salvestatud.

Ära arvuta finantsväärtusi browseris autoriteetselt.

---

# 23. Rounding

Defineeri üks rounding policy.

Dokumenteeri:

```text
currency minor units
rounding mode
line vs entry rounding
FX rounding
```

Ära kasuta binary float roundingut.

Lisa ADR või accounting docs.

Testi tüüpilisi juhtumeid:

```text
0.1 + 0.2
1/3 FX
many small lines
```

---

# 24. Ledger source of truth

Pärast POSTED state'i:

```text
journal_entries
+
journal_lines
```

on accounting source of truth.

Reportid tulevikus loevad ainult POSTED kandeid.

DRAFT ei lähe saldodesse.

REVERSED originaal jääb ajalukku, aga reversal neutraliseerib mõju.

---

# 25. Balance query foundation

Tee service/query foundation:

```text
getAccountBalance
getTrialBalance
getJournal
getGeneralLedger
```

v0.5-s vähemalt API/query tasemel.

Ära ehita veel kõiki report PDF-e.

Kontroll:

```text
trial balance total debit == total credit
```

---

# 26. Period enforcement

Posting business_date peab kuuluma sobivasse accounting period'i.

Kui perioodi pole:
DENY.

Kui CLOSED:
DENY.

Kui SOFT_CLOSED:
vastavalt permission policy'le.

Backdated posting CLOSED perioodi:
DENY.

Future date handling dokumenteeri.

---

# 27. Reopen period

Endpoint/service:

```text
reopenPeriod(periodId, reason)
```

Nõuded:

- `period.reopen`
- reason required
- audit event
- actor
- timestamp
- status transition
- võimalusel re-auth/2FA foundation kui olemasolev security service seda toetab

Ära tee fake reauth'i, kui infrastruktuur puudub; dokumenteeri.

---

# 28. Audit events

Lisa vähemalt:

```text
ACCOUNT.CREATED
ACCOUNT.UPDATED
ACCOUNT.DEACTIVATED

FISCAL_YEAR.CREATED
FISCAL_YEAR.CLOSED

PERIOD.CREATED
PERIOD.SOFT_CLOSED
PERIOD.CLOSED
PERIOD.REOPENED

JOURNAL.DRAFT_CREATED
JOURNAL.POSTED
JOURNAL.REVERSED

FX_RATE.CREATED
TAX_CODE.CREATED
TAX_CODE.UPDATED
```

Posted journal'i puhul audit metadata võib sisaldada:

```text
entry_id
entry_number
business_date
line_count
total_debit
total_credit
source_type
```

Ära logi dokumentide sisu ega secrets'e.

---

# 29. Error IDs

Lisa registry'sse vähemalt:

```text
ACC-001 ACCOUNT_NOT_FOUND
ACC-002 ACCOUNT_INACTIVE
ACC-003 DUPLICATE_ACCOUNT_CODE

PERIOD-001 PERIOD_NOT_FOUND
PERIOD-002 PERIOD_CLOSED
PERIOD-003 PERIOD_SOFT_CLOSED
PERIOD-004 INVALID_PERIOD_RANGE
PERIOD-005 REOPEN_REASON_REQUIRED

JRN-001 JOURNAL_NOT_FOUND
JRN-002 JOURNAL_NOT_DRAFT
JRN-003 JOURNAL_NOT_BALANCED
JRN-004 JOURNAL_LINE_INVALID
JRN-005 JOURNAL_IMMUTABLE
JRN-006 JOURNAL_ALREADY_REVERSED

FX-001 RATE_INVALID
FX-002 RATE_REQUIRED
```

Ära leki teise tenant'i objektide olemasolu.

---

# 30. RLS

Kõik tenant-owned accounting tabelid:

```text
RLS ENABLED
FORCE RLS
```

Direct tests:

```text
Tenant A account → Tenant B DENY
Tenant A journal → Tenant B DENY
Tenant A lines → Tenant B DENY
Tenant A periods → Tenant B DENY
Tenant A FX → Tenant B DENY
```

No tenant context:
0 rows / deny.

INSERT cross-tenant:
deny.

UPDATE tenant_id:
deny.

---

# 31. Runtime DB privileges

Runtime role ei tohi:

- ALTER schema
- DROP table
- BYPASSRLS
- muuta posted journal'e direct SQL-ga

Kui controlled DB function kasutab SECURITY DEFINER:
- ownership
- search_path
- EXECUTE grants
- input validation
peavad olema väga rangelt kontrollitud.

Dokumenteeri iga security-definer funktsioon.

---

# 32. API

Minimaalne v0.5 API võib sisaldada:

```text
GET/POST/PATCH /api/v1/accounts
GET/POST /api/v1/fiscal-years
GET/POST/PATCH /api/v1/accounting-periods

GET/POST /api/v1/journals
GET/PATCH /api/v1/journals/:id
POST /api/v1/journals/:id/post
POST /api/v1/journals/:id/reverse

GET /api/v1/ledger
GET /api/v1/trial-balance

GET/POST /api/v1/tax-codes
GET/POST /api/v1/fx-rates
GET /api/v1/currencies
```

Ära lisa endpointi ainult endpointide arvu pärast.

---

# 33. Desktop UI

Tilivo on desktop-first.

Lisa sidebar/navigation accounting foundation:

```text
Dashboard
Accounting
  Chart of Accounts
  Journal
  Periods
Documents
Settings
```

Sales/Purchases/Banking võivad jääda Coming Soon.

---

# 34. Chart of Accounts UI

Desktop table:

```text
Code | Account | Type | Status | Actions
```

Features foundation:

- search
- filter type
- active/inactive
- add account
- edit draft/master data
- deactivate

Ära hard-delete kontot, mida journal line juba kasutab.

DB FK peab seda kaitsma.

---

# 35. Journal UI

Desktop journal entry editor:

```text
Date
Description
Source
Currency

Lines:
Account | Description | Debit | Credit | Tax code
```

Footer:

```text
Total debit
Total credit
Difference
```

Difference peab näitama kasutajale kohe.

Aga backend on autoriteet.

Post button disabled kui frontend validation failib, kuid API kontrollib alati uuesti.

---

# 36. Posted journal UI

POSTED entry:

```text
read-only
```

Näita:

- entry number
- posted at
- posted by
- source
- lines
- totals
- audit link
- reverse action, kui permission olemas

Ära näita Edit nuppu.

---

# 37. Periods UI

Desktop table:

```text
Period | Start | End | Status | Actions
```

Actions:

```text
Soft close
Close
Reopen
```

Reopen nõuab reason modal'i.

---

# 38. Trial balance UI foundation

Näita vähemalt:

```text
Account
Debit
Credit
Balance
```

Period/date filter.

Total:

```text
Total debit == Total credit
```

Ära tee veel keerukat statutory report layout'i.

---

# 39. Finland starter chart

Lisa Soome jaoks starter chart seed/template, aga ära tee seda globaalseks kõigile riikidele.

Näiteks tenant/company onboarding või settings võib hiljem valida:

```text
Finland starter chart
Blank chart
```

v0.5-s piisab seed/template service'ist.

Kõik seed konto koodid ja nimetused eraldi data failis, mitte äriloogikas.

Kui täpset ametlikku standardit pole:
ära väida, et see on "official Finnish chart of accounts".

Nimeta see:

```text
Tilivo Finland Starter Chart
```

---

# 40. Concurrency tests

Kohustuslik:

## Journal numbering

```text
100 parallel journal posts
→ 100 unique numbers
→ no duplicates
```

## Double post

```text
same draft
20 parallel POST /post
→ exactly one successful state transition
```

## Reverse race

```text
same posted entry
20 parallel reverse
→ exactly one reversal
```

## Period close vs post

```text
post entry and close period concurrently
```

Lõppseis peab olema deterministlik:
kas posting jõuab enne lock'i ja close arvestab seda, või close võidab ja post denied.

Ei tohi tekkida posted entry closed perioodi pärast kontrolli race'i tõttu.

---

# 41. Property/invariant tests

Lisa property tests vähemalt:

```text
posted entry debit == credit
reversal net effect == 0
draft does not affect balance
posted does affect balance
closed period rejects post
cross-tenant rows never visible
tenant_id cannot move
account balance == sum(posted lines)
trial balance totals equal
```

---

# 42. Decimal tests

Kohustuslik:

```text
0.1 + 0.2
1000.00 + 240.00
many fractional FX lines
rounding edge cases
```

0 float drift.

Kui JS layer saab NUMERIC stringina:
testi serialization/deserialization.

---

# 43. Example accounting test

Testi klassikaline näide:

```text
Sales conceptual example:
D Accounts Receivable 1240.00
C Sales Revenue       1000.00
C VAT Payable          240.00
```

Kuigi Sales module pole veel olemas, manual journal test võib seda kasutada.

Expected:

```text
debit total = 1240
credit total = 1240
```

Ära ehita invoice logic'ut.

---

# 44. Opening balance test

Näiteks:

```text
D Bank 10,000
C Owner Equity 10,000
```

Post:
PASS.

Ledger:
Bank +10000
Equity +10000 credit-normal basis vastavalt balance query semantics'ile.

Dokumenteeri sign convention.

---

# 45. Normal balance semantics

Account balance semantics peab olema üheselt defineeritud.

Näiteks:

```text
ASSET/EXPENSE normal debit
LIABILITY/EQUITY/REVENUE normal credit
```

Ära jäta seda UI/service vahel erinevaks.

Lisa docs.

---

# 46. Performance/indexes

Indeksid vähemalt query patterns järgi:

```text
journal_entries(tenant_id, business_date)
journal_entries(tenant_id, status)
journal_lines(tenant_id, journal_entry_id)
journal_lines(tenant_id, account_id)
accounts(tenant_id, code)
accounting_periods(tenant_id, start_date, end_date)
fx_rates(tenant_id, rate_date)
```

Ära over-index'i.

---

# 47. Pagination

Journal ja ledger endpointid peavad olema paginated.

Eelistus:
cursor kui olemasolev platform pattern seda toetab.

Ära tagasta kogu pearaamatut korraga.

---

# 48. Security tests

Vähemalt:

```text
cross-tenant account read
cross-tenant journal read
cross-tenant journal post
cross-tenant reverse
cross-tenant period close
Viewer tries post
Employee tries period reopen
direct runtime SQL update posted line
direct runtime SQL delete posted entry
tenant header spoof
missing tenant context
```

Kõik DENY.

---

# 49. Audit security regression

v0.4 audit append-only peab säilima.

Accounting Core ei tohi anda runtime role'ile uusi õigusi, millega audit UPDATE/DELETE muutub võimalikuks.

Test uuesti.

---

# 50. Backup/restore

Enne production migrationit:

```text
DB backup
DB restore isolated test DB
document backup
object restore/hash verification
```

Kõik PASS.

Accounting migration upgrade testi:

```text
v0.4 snapshot
→ migrate v0.5
→ existing identity/tenant/docs/audit data preserved
```

---

# 51. CI

CI peab jooksutama:

```text
lint
typecheck
unit
auth regression
RLS regression
platform regression
accounting unit tests
journal invariant tests
concurrency tests
security tests
frontend tests
Playwright/E2E
production build
npm audit
```

Concurrency test võib olla eraldi job, kui see on aeglasem.

---

# 52. Documentation

Loo/uuenda:

```text
docs/ACCOUNTING_CORE.md
docs/JOURNAL_MODEL.md
docs/ACCOUNTING_PERIODS.md
docs/CURRENCIES_FX.md
docs/CHART_OF_ACCOUNTS.md

ARCHITECTURE.md
IMPLEMENTATION_STATUS.md
CHANGELOG.md
DEPLOYMENT.md
docs/ERROR_IDS.md
```

ADR-id vähemalt vajadusel:

```text
ADR-0014-journal-posting-invariants.md
ADR-0015-money-decimal-rounding.md
ADR-0016-journal-numbering.md
```

---

# 53. Production deploy gate

Deploy ainult kui:

```text
v0.2 auth regression          PASS
v0.3 RLS regression           PASS
v0.4 platform regression      PASS
fresh DB migration            PASS
v0.4 → v0.5 upgrade           PASS
journal balanced invariant    PASS
posted immutability           PASS
reversal invariant            PASS
period enforcement            PASS
journal numbering race        PASS
double-post race              PASS
reverse race                  PASS
cross-tenant accounting       PASS
decimal tests                 PASS
backup/restore                PASS
Playwright                    PASS
npm audit                     PASS
```

---

# 54. Production migration

Enne:

```text
production DB backup
restore test
```

Seejärel:

```text
migrate
verify schema
verify RLS
verify grants
verify old modules
```

Ära loo productionisse demo accounting data't ilma vajaduseta.

---

# 55. Production smoke

Kasuta test tenant'i.

Testi vähemalt:

```text
create account
create fiscal year
create open period
create balanced manual journal draft
post
read ledger
read trial balance
attempt edit posted entry → DENY
reverse
verify net effect 0
close period
attempt posting → DENY
reopen with reason
cross-tenant journal access → DENY
```

Cleanup või jäta testandmed selgelt tähistatuks ainult QA tenant'is.

---

# 56. Existing server services

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

Kõik peavad olema vähemalt sama health state'iga.

---

# 57. Public production

Tilivo on internet-facing.

Ära lisa:

- debug accounting endpoints
- unsafe SQL endpoint
- direct journal status update endpoint
- public ledger export ilma auth/permissionita
- test bypass
- exposed DB details

---

# 58. v0.5 Security / Accounting mini-review

Enne gate PASS-i kontrolli:

```text
unbalanced post
posted mutation
posted delete
duplicate entry number
double post
double reverse
close/post race
cross-tenant accounting read
cross-tenant accounting write
permission escalation
decimal drift
FX invalid rate
missing period
audit integrity regression
```

CRITICAL/HIGH = 0 open.

---

# 59. Git

Tee loogilised commitid.

Näiteks:

```text
feat: add chart of accounts and accounting periods
feat: add journal entry and line model
feat: enforce immutable balanced journal posting
feat: add journal reversal and numbering
feat: add currencies tax codes and fx foundation
feat: add accounting desktop views
test: add accounting invariants and concurrency coverage
docs: document Tilivo accounting core
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

# 60. Stop conditions

Peata ja küsi enne, kui:

- backup FAIL
- restore FAIL
- migration võib kaotada olemasolevaid andmeid
- balanced-entry invariant ei ole DB/service tasemel usaldusväärselt tagatud
- runtime role saab posted journal'i muuta
- journal numbering race tekitab duplicate
- cross-tenant accounting leak
- decimal library/storage model tekitab float drift'i
- production deploy mõjutab võõraid teenuseid

---

# 61. Lõpparuanne

Anna täpne raport.

## 1. Schema

```text
accounts
fiscal_years
accounting_periods
journal_entries
journal_lines
tax_codes
currencies
fx_rates
```

PASS/FAIL.

## 2. Journal engine

```text
Draft:
Post:
Balanced invariant:
Entry numbering:
Posted immutability:
Reverse:
Correction foundation:
Source linkage:
```

## 3. Periods

```text
Open:
Soft close:
Close:
Reopen:
Close/post race:
```

## 4. Money / FX

```text
NUMERIC:
Decimal handling:
Rounding:
Base currency:
FX rates:
No float drift:
```

## 5. RLS / Security

```text
Accounts isolation:
Journal isolation:
Lines isolation:
Periods isolation:
FX isolation:
Missing tenant fail-closed:
Runtime posted mutation denied:
```

## 6. Concurrency

```text
100 parallel posts:
Double post:
Double reverse:
Period close/post:
```

## 7. Accounting invariants

```text
Debit == Credit:
Reversal net 0:
Draft no balance effect:
Posted balance effect:
Trial balance equal:
```

## 8. UI

```text
Chart of Accounts:
Journal:
Posted read-only:
Periods:
Trial Balance:
Desktop:
Mobile responsive:
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
Accounting smoke:
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
V0.5 ACCOUNTING CORE GATE: PASS
```

või:

```text
V0.5 ACCOUNTING CORE GATE: FAIL
```

Kui PASS:

```text
STOP – v0.6 Sales ei alusta.
```

Kui FAIL:
näita täpselt blockerid.

---

# 62. Alusta nüüd

```text
Read docs/repo
→ preflight
→ backup/restore
→ accounting schema design
→ ADRs
→ migrations
→ accounts
→ fiscal years
→ periods
→ journal drafts
→ posting engine
→ balanced invariant
→ numbering
→ immutability
→ reversal
→ currencies/FX
→ tax code foundation
→ ledger/trial balance queries
→ permissions/audit/error IDs
→ desktop UI
→ unit/integration/security tests
→ concurrency/property tests
→ full regression
→ accounting/security mini-review
→ fix findings
→ production backup
→ migrate/deploy
→ production accounting smoke
→ verify old services
→ docs
→ Git push
→ V0.5 ACCOUNTING CORE GATE
→ STOP
```

Kõige tähtsamad nõuded:

> **Journal on Tilivo raamatupidamise source of truth.**

> **POSTED kanne on immutable.**

> **Ükski unbalanced kanne ei tohi saada POSTED staatust.**

> **Parandus toimub reversal/correction entry kaudu, mitte ajaloo ümberkirjutamisega.**

> **Kõik tenant-owned accounting data peab olema PostgreSQL RLS-ga kaitstud.**
