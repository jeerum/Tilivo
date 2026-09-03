# Implementatsiooni staatus

## Current version

**v0.7 (Purchases) - GATE PASS**

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

- v0.4 Audit & compliance edasiarendus
- v0.8 Banking, v0.9 Payments, v0.10 FI VAT reporting/period close
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

## Tests

```text
Local: API lint/typecheck/unit 25 PASS, web lint/typecheck/unit 6 PASS,
       web build PASS
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
- Production DB migrated to v0.7 (12 migrations), api/web/worker containers
  rebuilt,
  worker/db healthy; existing host/container services unchanged.
- Production test tenant cleanup complete; QA tenants (Tilivo QA Tenant,
  E2E Switch Tenant, E2E Accounting QA Tenant) are intentional fixtures.

## Next step

v0.8 Banking - ei alustata enne eraldi ülesannet.
