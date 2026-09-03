# Changelog

## [0.7.0] - 2026-09-03

- Supplier kasutab `business_parties` (`is_supplier`) koos
  default_expense/default_tax lisadega.
- Purchase schema: purchase_invoices/lines, documents, approvals,
  extractions, corrections, imports, settings; RLS+FORCE ja komposiit-FK-d.
- Lifecycle: INGESTED/DRAFT -> NEEDS_REVIEW -> READY_FOR_APPROVAL -> APPROVED
  -> POSTED; reject, cancel, correction-reversal; posted immutable ka otse
  SQL-i eest.
- Approval: `require_separate_approver` ja `auto_post_on_approval`
  tenant-seadistusena.
- E-arve: secure XML, canonical model, Finvoice/PEPPOL/TEAPPSXML adapterid,
  structured extraction read, deterministic supplier matching.
- Duplicate/idempotency: inbox external key + source_external unique + tarnija
  number/kuupäev unique; 20-parallel import -> üks arve.
- Accounting: PURCHASE_INVOICE kanne läbi v0.5 mootori, input VAT ja
  reverse-charge foundation, PURCHASE_CORRECTION reversal.
- Desktop UI `/purchases` (invoices, suppliers, inbox; ET/EN).
- Tests: parserid + XML hostile, lifecycle, approval SoD, races, RLS, upgrade.

## [0.6.0] - 2026-09-02

- Sales schema: business_parties, invoice_number_series, sales_settings,
  sales_invoices/lines, sales_invoice_pdfs, sales_invoice_credit_links;
  RLS + FORCE + komposiit-FK-d `(tenant_id, id)`.
- Number eraldatakse atomically ISSUE ajal; issued arve ja read on
  immuutsed (ka otse SQL-i eest); kreeditlink insert-only; PDF READY on
  külmutatud.
- Issue-transaction: serveripoolne ümberarvutus, kliendi snapshot,
  seerianumber, makseviide, pearaamatukanne (AR/tulu/käibemaks), staatuse
  muutus ning outbox `SALES_INVOICE_ISSUED` /
  `SALES_INVOICE_PDF_REQUESTED`.
- Payment references: FI domestic (7-3-1) ja RF (ISO 11649) testvektoritega.
- Serveripoolne deterministlik PDF-render + worker-töötlus +
  document/version salvestus + SHA-256.
- Täiskreeditarve oma numbriga ja peegelkandega; originaal -> CREDITED.
- API: customers, sales/series, sales/settings, sales/invoices
  (draft, issue, credit, cancel-draft, pdf, pdf/retry).
- Permissions: sales.read, sales.customer.manage, invoice.create/issue/credit/
  pdf.retry, sales.settings.manage.
- Desktop UI `/sales` (Customers / Invoices, ET/EN) + Playwright E2E.
- Tests: sales lifecycle, PDF idempotency, 100 parallel numbering, double
  issue, credit race, RLS/cross-tenant hostile, direct DB immutability,
  upgrade migration v0.4 -> v0.6.

## [0.5.0] - 2026-09-02

- Accounting schema: accounts, fiscal_years, accounting_periods,
  journal_entries/journal_lines/journal_reversals, tax_codes, fx_rates,
  currencies, journal_sequences; RLS + FORCE RLS on tenant-owned tables.
- Controlled posting engine with period enforcement, balance invariant,
  atomic `YYYY-######` numbering and mirrored reversals.
- DB hardening: posted immutability (incl. direct runtime SQL), DRAFT-only
  insert rule, reversal linkage/mirror validation.
- API: journal list/detail, ledger + account ledger, trial balance, tax codes,
  FX rates + conversion, currencies; journal drafts accept tax codes.
- Permissions accounting.read/journal.*/period.*/chart.manage; desktop UI
  `/accounting` with journal, chart, periods and reports (ET/EN).
- Bugfixes vs 6cf0cd7: reversal status transition, first entry number,
  journal_entries INSERT trigger, builtin role accounting permissions,
  tax code unique index.
- Tests: v0.4 -> v0.5 upgrade, DB immutability, double post, 100 parallel
  numbering, reversal race, period close vs post, tax/FX, ledger/trial balance,
  permission/RLS/CSRF matrix.
- Audit events for accounting actions on the existing hash chain; audit chain
  writes serialised before transaction start (concurrency fix).

## [0.5.0 gate closure] - 2026-09-02

- Full regression 71/71 PASS (server test DB), local test:ci PASS, npm audit 0.
- Production: backup/restore + SHA-256 PASS; v0.4 backup copy migrated to v0.5
  with data preserved; production migrate + api/web deploy PASS.
- Production accounting smoke 34/34 PASS; Playwright UI 8 PASS / 1 skip.
- Existing host/container services unchanged.
- `V0.5 ACCOUNTING CORE GATE: PASS`.

## [0.4.0-partial] - 2026-09-02

- Desktop-first AppShell (sidebar + topbar, wide workspace).
- Audit: hash-chain, append-only, runtime UPDATE/DELETE denied.
- Documents/document_versions + local object storage + RLS; upload/confirm/download API.
- Retention policies/holds foundation.
- Integration inbox/outbox + `tilivo-worker` container.

## [0.4.0 gate closure] - 2026-09-02

- Object storage backup/restore + SHA-256 verification PASS.
- Production document/audit/cross-tenant smoke PASS.
- Playwright desktop/tablet/mobile + tenant switch PASS.
- `V0.4 PLATFORM + DESKTOP UI GATE: PASS`.

## [0.3.0] - 2026-09-02

- Multi-tenant domain: tenants, companies, memberships, roles, permissions.
- PostgreSQL RLS: runtime roll `tilivo_runtime` (NOSUPERUSER/NOBYPASSRLS), FORCE RLS,
  transaction-scoped tenant context, security definer funktsioonid.
- Tenant API ja frontend (onboarding + switcher + company/member/role vaade).
- Viimase Owner'i kaitse, membership/permission kontroll, audit sündmused.

## [Avalik kasutus 2026-09-02]

- `https://tilivo.mrjaak.com` on avalikult kasutusel (Let's Encrypt + isoleeritud nginx-vhost).
- `APP_BASE_URL` uuendatud.

## [Security review 2026-09-02] - v0.2

- Harden: verification/reset/challenge one-time atomicity.
- TOTP replay protection (`last_used_counter`).
- IDOR session revoke -> 404; timing enumeration mitigatsioon.
- `Cache-Control: no-store` auth vastustel; explicit trust proxy CIDR.
- Config guard: dev email/outbox keelatud production'is.
- Docs: `docs/SECURITY_REVIEW_V0_2.md`, ADR-0006.

## [Rename 2026-09-02] - MRJKP -> Tilivo

- Toote branding, HTML/UI, README/docs: Tilivo.
- Package nimed: `tilivo`, `@tilivo/api`, `@tilivo/web`.
- Cookie nimed: `tilivo_session`, `tilivo_csrf`.
- Docker Compose projekt ja containerid: `tilivo`, `tilivo-db/api/web`.
- Serveri kaust: `/opt/tilivo`; systemd: `tilivo-backup.*`.
- DB: `tilivo_accounting`, kasutaja `tilivo_app` (sama data, sama TOTP key).
- Füüsiline volume legacy nimega säilitatud; vanad MRJKP backupid jäid ajalooks.

## [0.2.0] - 2026-09-02

### Added

- v0.1 hardening: automaatne DB backup (systemd timer), restore-test, health endpointi kärpimine
  production'is, ADR-0004 PostgreSQL versioonipoliitika.
- v0.2 Identity: users, register, e-mail verification, login/logout, password reset/change,
  TOTP 2FA, recovery codes, sessioonid (remember me 30 päeva), CSRF double-submit, rate limiting,
  audit events, auth Error ID-d.
- Frontend auth UI (ET/EN) ja CI integration-DB.

### Deploy

- v0.2 deploy `/opt/mrjkp-accounting`; migratsioon `20260902120000_identity` rakendatud; backup enne
  migratsiooni tehtud ja restore-testitud.

## [0.1.0] – 2026-09-02

### Added

- v0.1 infrastruktuur: repo struktuur, backend/frontend skeletonid.
- `GET /api/v1/health` koos PostgreSQL kontrolliga.
- Migratsioonisüsteem (node-pg-migrate) ja esimene migratsioon `pgcrypto`.
- Struktureeritud logi, Trace ID ja Error ID.
- Config-valideerimine (Zod), lint, typecheck, unit-testid, prod-build.
- Isoleeritud Docker Compose deploy alus (projekt `mrjkp`).
- Dokumentatsioon ja ADR-id.

### Deploy

- Esimene isoleeritud v0.1 deploy VPS-ile (`/opt/mrjkp-accounting`), pordid 3100/3101 localhostis.
