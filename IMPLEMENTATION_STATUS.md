# Implementatsiooni staatus

## Current version

**v0.10 (Purchases & Receipts) - COMPLETE / GATE PASS**

Gate validated:
- migrations `20260907000000_purchases_receipts_v10` and
  `20260907010000_purchase_merchant_review` (17 total);
- API tests 186/186 PASS, 0 skipped (v0.10 unit 9 + integration 6 plus full
  regression v0.5-v0.9);
- web unit tests 16/16 PASS; lint/typecheck/build PASS;
- Playwright VAT + Receipts browser QA 9/9 PASS
  (desktop/tablet/mobile).

Previous v0.9 gate:

Gate validated:
- migration `20260906000000_vat_engine_v09` runs cleanly on dev + test DB
  (15 migrations; 22 statutory FI tax codes seeded per tenant);
- API tests 171/171 PASS, 0 skipped (v0.9 VAT unit 13 + integration 14,
  full v0.5-v0.8 regression green);
- web unit tests 16/16 PASS; lint/typecheck/build PASS;
- Playwright VAT browser QA PASS (desktop/tablet/mobile) - see v0.9 section.

Official Finnish VAT rules verified against vero.fi on 2026-09-03
(25.5 % general, 13.5 % reduced from 2026-01-01, 10 %, 0 % taxable,
construction RC AVL 8 c / Art. 199 EU VAT Directive).

Olemasolev accounting-core auditeeritud ja lõpetatud (ei ole ümberkirjutatud).
GATE valideeritud:
- migratsioon `20260905010000_accounting_core_v08` jookseb puhtalt (dev +
  test DB, 14 migratsiooni);
- API testid 144/144 PASS (sh v0.8 accounting 7, 0 skip);
- Playwright accounting-v08 browser QA PASS 9/9
  (desktop + tablet + mobile: manual journal, opening balances, period lock);
- lint/typecheck/build PASS.

Eelnevad gate'id: v0.7.5 GATE PASS, v0.7 GATE PASS, v0.6 GATE PASS,
v0.5 GATE PASS, v0.4 GATE PASS.
- lint/typecheck/build PASS.

Varased gate'id: v0.7 GATE PASS, v0.6 GATE PASS, v0.5 GATE PASS, v0.4 GATE PASS.

v0.6 gate: **PASS**. v0.5 gate: **PASS**. v0.4 gate: **PASS**.
Security review: v0.2 CRITICAL/HIGH 0 open
(`docs/SECURITY_REVIEW_V0_2.md`).

## Completed

- v0.1 infrastructure, backup systemd, health, ADR-0004.
- v0.2 Identity: users, verification, sessions, TOTP 2FA, recovery codes,
  rate limiting, audit, CSRF.
- Rename MRJKP -> Tilivo (branding/packages/cookies/compose/server/docs).
- v0.3 tenants/companies/memberships/roles/permissions, runtime role +
  FORCE RLS, tenant transaction helper.
- v0.4 desktop AppShell, audit hash-chain append-only, documents + object
  storage + hostile matrix, retention foundation, inbox/outbox + worker,
  backup/restore, Playwright desktop/mobile.
- v0.5 Accounting Core (see below).
- v0.6 Sales (see below).
- v0.7 Purchases (see below).
- v0.7.5 Business Registry Integration (see below).
- v0.8 Accounting Core 1 (see below).
- v0.9 VAT / ALV Engine (see below).
- v0.10 Purchases & Receipts (see below).

## v0.5 Accounting Core

### Schema / invariants

- Tenant-owned tables: `accounts`, `fiscal_years`, `accounting_periods`,
  `journal_entries`, `journal_lines`, `journal_reversals`, `tax_codes`,
  `fx_rates`; RLS enabled + FORCE; `currencies` global reference;
  `journal_sequences` atomic counter per tenant/fiscal year.
- Every `POSTED` journal is balanced (service check + DB AFTER UPDATE trigger),
  has >= 2 lines and active same-tenant accounts.
- `POSTED`/`REVERSED` entries and lines are immutable, including direct
  runtime-role SQL. Journals may only be inserted as DRAFT; a reversal requires
  a linked `journal_reversals` row whose entry mirrors original lines.
- Money: NUMERIC columns; `decimal.js` for service arithmetic; API returns
  decimal strings; no binary float on the authoritative path.

### Engine / API

- Controlled posting path (entry lock first, then period), atomic
  `YYYY-######` numbering at posting time, reversal through the same flow.
- Periods: OPEN/SOFT_CLOSED/CLOSED, close+reopen with reason/actor, close-vs-post
  race serialised.
- APIs: accounts, fiscal-years, accounting-periods, journals + detail,
  post/reverse, ledger (+ account ledger), trial balance, tax codes,
  fx rates + conversion, currencies.
- Permissions: `accounting.read`, `journal.create/post/reverse`,
  `period.manage/reopen`, `chart.manage`; Owner/Admin all, Accountant
  read/create/post, Viewer/Employee none.
- Desktop UI `/accounting`: journal draft/post/reverse, chart of accounts,
  periods, trial balance + ledger; ET/EN.
- Audit events for account/journal/period/tax/fx actions on the v0.4 hash chain.

### Bugs found and fixed on top of 6cf0cd7

- Reversal never marked the original entry REVERSED (reversal endpoint failed
  once DB hardening was enforced).
- First entry number started at `000000` instead of `000001`.
- No INSERT trigger on `journal_entries`; POSTED inserts and posted-line inserts
  were possible at DB level.
- New tenants' Owner/Admin/Accountant roles lacked the accounting permissions
  (fixed in builtin role seeds).
- Tax code uniqueness index was not unique (new migration adds it).

## Not started

Uus plaan alates v0.7.5 on `ROADMAP.md`; v0.7.5 ja v0.8 on valmis, edasi
ehitatakse täisväärtuslikku Soome raamatupidamistarkvara.

- v0.9 VAT / ALV Engine ja edasised moodulid vastavalt ROADMAP.md-le
- v0.4 Audit & compliance edasiarendus
- Production SMTP driver

## v0.6 Sales

### Schema / invariants

- Tenant-owned: `business_parties`, `invoice_number_series`,
  `sales_settings`, `sales_invoices`, `sales_invoice_lines`,
  `sales_invoice_credit_links`, `sales_invoice_pdfs`; RLS + FORCE RLS ja
  komposiit-FK-d `(tenant_id, id)`.
- Arve number eraldatakse ainult ISSUE ajal atomically seeriast.
- ISSUED arve ja read on immuutsed; number/payment reference/snapshot/journal
  link on kohustuslikud. Kreeditlink on insert-only; READY PDF on külmutatud.
- Summad NUMERIC; line-level sentide ümardamine `decimal.js`; ISSUE arvutab
  kõik summad serveris uuesti.

### Engine / API / UI

- Issue-transaction: DRAFT -> ISSUED koos kanne + outbox; DRAFT canceldatav.
- Täiskreeditarve oma numbriga (SALES_CREDIT_NOTE) ja peegelkanne; originaal
  CREDITED.
- PDF: deterministlik serverirender, worker outboxi kaudu, SHA-256 + document
  versionid; retry ja allalaadimine auth'iga.
- API customers/series/settings/invoices; permissions sales.* / invoice.*.
- Desktop UI `/sales`: Customers, Invoices, read-only issued vaade, PDF olek,
  credit action.

### Katvus

- 13 sales integration/security/concurrency testi (server test DB) koos
  olemasoleva 96-testilise regressiooniga.
- 100 parallel issue -> 100 unikaalset numbrit; double issue ja credit race
  -> täpselt üks õnnestumine; PDF duplicate job -> üks dokument.

## v0.7 Purchases

### Schema / invariants

- Tenant-owned: purchase_invoices/lines/documents/approvals/extractions/
  corrections/imports/settings; RLS + FORCE RLS ja komposiit-FK-d.
- Supplier capability jääb `business_parties` mudelisse (`is_supplier`).
- POSTED/APPROVED/CORRECTED on immutable; korrektsioon = reversal-journal.
- E-arve idempotency: inbox external key + `(tenant, source_type,
  source_external_id)` unique + tarnija number/kuupäev unique.

### Engine / API / UI

- Lifecycle review/approve/post/reject/correct; `require_separate_approver` ja
  `auto_post_on_approval` tenant-seadistusena.
- PURCHASE_INVOICE kanne (Expense/Input VAT/AP) läbi v0.5 mootori,
  reverse-charge foundation, PURCHASE_CORRECTION reversal.
- Secure XML + canonical Finvoice/PEPPOL/TEAPPSXML adapterid; OCR Noop
  foundation; manual review ilma OCR-ita.
- Desktop `/purchases`: invoices, suppliers, e-invoice import/inbox.

### Katvus

- Parser/XML security 9, purchase lifecycle integration 3, security/races 4
  (server test DB); kogu regressioon täiendatud upgrade-testiga v0.4 -> v0.7.

## v0.7.5 Business Registry

### Arhitektuur / API

- Provider-abstraktsioon (`BusinessRegistryProvider`) + rakendus-taseme
  `BusinessRegistryService`; UI ei räägi kunagi otse PRH-ga. Finland-first,
  riigist sõltumatu mudel (ET/SE saab lisada hiljem ilma UI muutuseta).
- Provider: PRH YTJ open data v3 (avalik, CC BY 4.0, API-võtit ei ole).
- `GET /api/v1/business-registry/search?q=` (nimi või Y-tunnus) ja
  `GET /api/v1/business-registry/companies/:businessId`; permission
  `registry.read` kõikidele sisemistele rollidele.
- Y-tunnus: normaliseerimine, struktuur + modulus-11 kontrollsumma enne
  võrgupäringut; VAT kuju FI + 8 numbrit eraldi registreerimisstaatuse infost.
- Normaliseeritud `RegistryCompany` + Zod-validatsioon; provider-spetsiifilised
  koodid (status, trade register, registri- ja registrikanded) säilitatakse
  snapshot'is, mitte suuri raw-payload'e.

### Andmed / voog

- `business_parties`: `registry_source`, `registry_source_id`,
  `registry_fetched_at`, `registry_snapshot` (nullable, olemasolevad read
  muutmata).
- `business_registry_cache` (provider/lookup_type/lookup_key, TTL) +
  rakenduse sliding-window rate limit; UI debounce; 429 -> REG-004.
- Kliendi ja tarnija loomine/muutmine: otsing -> valik -> vormi autofill ->
  kasutaja kinnitus; olemasoleva sisendi ülekirjutamine küsib kinnitust;
  käsitsi sisestus jääb alati võimalikuks (registri langus ei blokeeri
  loomist).
- Audit: CUSTOMER/SUPPLIER.REGISTRY_IMPORTED / REGISTRY_REFRESHED.
- UI ET/EN; mobiilis sama funktsionaalsus (form-row wrap, tulemuste nimekiri
  ilma horisontaalse overflow'ta).

### Katvus

- Unit: business ID 5, provider (mocked fetch) 7, service/cache/rate limit 4,
  frontend helper 3.
- Integration (server test DB, fake provider): 9 testi – name/Y-otsing,
  invalid Y (providerit ei kutsuta), not-found, cache, kliendi/tarnija
  import + refresh/clear, provider down + manual fallback, rate limit.
- GATE: kohalik PostgreSQL 17 + `tilivo_accounting`/`tilivo_accounting_test`,
  migratsioonid rakendatud; API 137/137 PASS, web 9/9 PASS, Playwright
  registry 9/9 PASS (desktop/tablet/mobile), live PRH smoke PASS.

## v0.8 Accounting Core 1

### Audit tulemus (lühidalt)

- EXISTS: double-entry kanne/rida, DRAFT->POSTED->REVERSED, konto plaan,
  perioodid + soft/hard close + reopen, manuaalne kanne/postitamine,
  idempotentne müügi/ostu automaatpostitus koos source_type/source_id-ga,
  immutability (teenus + DB triggerid), audit hash-chain, NUMERIC + decimal.js,
  journal_sequences konkurrentsikindel numberdus.
- PARTIAL: rea dimensioonid puudusid, reversal-i päises puudus
  reversal_of_entry_id/source-side, konto aktiivsuse haldus puudus UI-s,
  journal detail/allika näit UI-s puudus, perioodi kinnitused puudusid.
- MISSING: avasaldo (opening balances) voog, journal line
  cost_center/project_code, document_date, rea CHECK piirangud, v0.8 testid.

### Implementeeritud

- Migratsioon `20260905010000_accounting_core_v08`: `journal_entries.
  document_date`; `journal_lines.cost_center`, `project_code`; CHECK-id
  (mitte-negatiivsed, deebet/kreedit üksteist välistavad); unikaalne
  `OPENING_BALANCE` postitatud kanne kuupäeva kohta; dimensiooniindeksid;
  reversal-mirror valideerimine koos dimensioonidega.
- Opening balances API (`POST /api/v1/opening-balances`), audit
  `OPENING_BALANCE.POSTED`, duplikaaditõrge ACC-004, lukustatud perioodi
  blokeering ja UI vaheleht „Algsaldod“.
- Reversal-kanne seob nüüd `reversal_of_entry_id` + source_type
  `JOURNAL_REVERSAL`; ostu korrektsioon sama mustriga.
- Kontode aktiveerimine/deaktiveerimine (`PATCH /api/v1/accounts/:id`,
  `ACCOUNT.UPDATED`) + UI nupp; mitteaktiivne konto blokeerib postituse.
- Journal API/UI: `document_date`, dimensioonide väljastamine, source-veerg,
  kande detailvaade (allikas + read + dimensioonid), konto filter,
  deebet/kreedit/vahe kokkuvõtted, tasakaalustamata drafti Post-nupp keelatud.
- Perioodi sulgemine/avamine küsib UI-s kinnitust; tabelid on mobiilis
  horisontaalselt keritavad ja kande read liiguvad kitsal ekraanil üksteise
  alla.
- Frontend sent-põhine summakuvamine (`lib/money.ts`) + testid.

### Katvus

- API 144/144 PASS (0 skipped): uued v0.8 integratsioonitestid 7 (opening
  balance + duplikaat, locked/reopened period, line-validatsioon, reversal
  dimension/mirror, sales/purchase source trace + duplicate block, audit +
  inactive account).
- Web unit 12 PASS (sh money 3); Playwright accounting-v08 9/9 PASS.

## v0.9 VAT / ALV Engine

### Schema / invariants

- `tax_codes` semantic model: `direction`, `treatment`, reverse charge /
  intra-EU / export / import flags, `deductible_percent`, `legal_notes`,
  `is_system`; CHECK constraints and indexes; legacy `type` preserved.
- `journal_lines` freezes VAT metadata (code snapshot, treatment, rate,
  taxable base, tax amount, deductible/non-deductible split, leg type,
  reporting classification, legal note); reversals mirror the metadata.
- `sales_invoice_lines` / `purchase_invoice_lines` snapshots:
  `tax_code_snapshot`, `tax_treatment_snapshot`,
  `deductible_percent_snapshot`, `tax_legal_note`.
- Permissions `tax.read`, `tax.manage`, `tax.report.read` (Owner/Admin
  manage+read; Accountant read+report; Viewer/Employee read).
- Idempotent seed: 22 statutory FI codes per tenant incl. rate history
  (24 -> 25.5 %, 14 -> 13.5 %, 10 %) and tenant-creation seeding.

### Engine / API / UI

- `vatEngineService.ts`: semantic tax engine - domestic standard/reduced,
  zero-rated, exempt, EU goods/services supply+acquisition, export, import,
  general reverse charge, construction reverse charge, deductibility
  (100/0/partial), deterministic cent rounding, localised legal notes.
- Sales and purchase posting consume the engine and post only through the
  Accounting Core; credit notes / purchase corrections invert VAT; period
  lock and idempotency preserved.
- `GET /api/v1/vat-summary` (ALV summary) + UI accounting VAT tab; tax-code
  admin view; statutory codes protected (TAX-004).
- Sales/purchase UI: per-line tax selector with meaningful labels,
  net/VAT/gross preview, VAT breakdown, deductibility picker, legal notes;
  PDF gains tax summary and legal-note block.

### Katvus

- Unit 13 (rounding/treatments/deductibility/classification/legal notes);
  integration 14 (seed, sales/purchase posting metadata, multi-rate,
  deductibility, RC/EU/export/import readiness, construction RC,
  historical-rate stability, credit inversion, VAT summary, permissions,
  period lock, idempotency); web unit 16; Playwright VAT browser 6/6
  (desktop/tablet/mobile sales RC + purchase partial + summary + journal).
- Full API regression 171/171 PASS on fresh test DB; lint/typecheck/build
  PASS; docs `docs/VAT_ENGINE.md` + `docs/VAT_ENGINE_GAP_ANALYSIS.md`.

## v0.10 Purchases & Receipts

- Recovery commit `ffa99d1` before v0.10 work.
- Unified purchase-document model: document types, payment methods/status,
  merchant-only receipts, OCR state, duplicate warnings; payment
  counter-account mappings in purchase settings.
- Receipts tab in Purchases (desktop/mobile), Add receipt, upload/camera,
  OCR via provider abstraction (deterministic mock), supplier matching with
  ambiguity guard, heuristic + SHA-256 duplicate warnings.
- Payment-aware posting: AP, cash, company-card clearing, employee payable;
  all through Accounting Core + VAT engine; posted documents immutable.
- Unit 9, integration 6, web 16, Playwright VAT+Receipts 9/9
  (desktop/tablet/mobile); full API regression 186/186 PASS, 0 skipped.

## Tests

```text
Local: API lint/typecheck PASS, API tests 144/144 PASS (fresh test DB,
       MIGRATION_DATABASE_URL sees - ka upgrade-test), web lint/typecheck
       PASS, web tests 12/12 PASS, build PASS
Server test DB (fresh reset each run): PASS (kogu regressioon)
  - v0.4 -> v0.7 upgrade migration on scratch DB (data preservation, RLS,
    grants, triggers, sales + purchase seed)
  - posted immutability direct runtime SQL
  - double post + reversal race + period close vs post race
  - 100 parallel posts -> 100 unique contiguous numbers
  - tax/FX CRUD + conversion
  - journal/ledger/account-ledger/trial-balance views
  - role permission matrix + cross-tenant RLS + auth/CSRF guards
  - v0.6 sales: lifecycle, PDF worker/storage/idempotency, credit notes,
    payment references, RLS/cross-tenant hostile, direct DB immutability,
    100 parallel numbering, double issue, credit race
- v0.7 purchases: parsers + XML hostile, lifecycle, SoD, approve/post/
    correction races, external import idempotency, RLS/cross-tenant,
    direct DB immutability
  - v0.7.5 registry: unit 16 PASS; integration 9 fake-provider testi PASS;
    upgrade-test kontrollib ka registry tabeli/veerud/õigused
  - v0.8 accounting: unit money 3 PASS; integration 7 PASS (0 skipped);
    Playwright 9/9 PASS desktop/tablet/mobile
  - v0.2 auth 18, v0.3 tenant/RLS 6, v0.4 platform 6 (incl. parallel audit
    chain), unit/security/env/health 25
Production UI Playwright: full suite PASS (sales + purchases included)
npm audit (root/api/web): 0 vulnerabilities
Production smoke: v0.5 accounting + v0.6 sales + v0.7 purchase flow PASS
Backup/restore + SHA-256 verify: PASS
Production v0.4 backup copy -> migrate -> data preservation: PASS
```

## Deployment status

- `/opt/tilivo`, containers `tilivo-*`, ports 127.0.0.1:3100/3101; public
  https://tilivo.mrjaak.com (Let's Encrypt + isolated nginx vhost).
- Production DB migrated to v0.7.5 (13 migrations), api/web/worker containers
  rebuilt, worker/db healthy; existing host/container services unchanged
  (deploy 2026-09-03: backup enne, migratsioon ainult
  `20260905000000_business_registry`, smoke PASS).
  - v0.8 deployed production (2026-09-03): backup enne, kood sünkroniseeritud,
    `remote-deploy.sh` PASS, migratsioon ainult
    `20260905010000_accounting_core_v08` (13 -> 14), smoke PASS; teised
    serveriteenused puutumata.
  - v0.9 deployed production (2026-09-03): backup + restore-verify PASS
    (`tilivo_accounting_20260903_104328.sql.gz`, document SHA-256 PASS),
    kood sünkroniseeritud, `remote-deploy.sh` PASS, migratsioon ainult
    `20260906000000_vat_engine_v09` (14 -> 15), production VAT Playwright
    6/6 PASS (desktop/tablet/mobile), teised serveriteenused puutumata.
- Production test tenant cleanup complete; QA tenants (Tilivo QA Tenant,
  E2E Switch Tenant, E2E Accounting QA Tenant) are intentional fixtures.

## Next step

v0.9 VAT / ALV Engine vastavalt ROADMAP.md-le (ei alustata enne eraldi
ülesannet).
