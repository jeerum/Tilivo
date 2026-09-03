# Changelog

## [0.11.0] - 2026-09-03

- AI expense classification: provider abstraction with deterministic mock,
  structured Zod-validated suggestions, tenant-scoped resolution, confidence
  and concise reasons.
- Deterministic history signals (supplier -> account/tax/deductibility/
  payment) feed the classifier; input fingerprint caches unchanged runs.
- Classification runs table + permissions (`purchase.classify`,
  `purchase.classification.apply`), audit events, provider failure fallback.
- Receipt detail AI panel: classify, confidence cards, per-field accept,
  Apply all, Re-run; purchase documents reuse the same service.
- Migration `20260908000000_ai_classification_v11` (18 total).
- Tests: v0.11 unit 5, integration 4, browser E2E 12/12
  (VAT + Receipts + AI, desktop/tablet/mobile); full API 195/195 PASS.
- Production deploy (2026-09-03): backup + restore-verify PASS, code
  synced to `/opt/tilivo`, `remote-deploy.sh` PASS, migration only
  `20260908000000_ai_classification_v11` (17 -> 18), production AI
  Playwright 3/3 PASS; other host services untouched.

## [0.10.0] - 2026-09-03

- Pre-v0.10 recovery commit `ffa99d1` (v0.7.5-v0.9 foundation).
- Unified purchase-document model on existing purchases:
  `document_type`, `payment_method`, `payment_status`, `merchant_name`,
  `description`, `ocr_status/provider/error`, `duplicate_warning`;
  payment counter-account settings (cash, company card, employee payable).
- Receipt workflow: Receipts tab + Add receipt, file/camera upload,
  OCR via `DocumentOcrProvider` abstraction with deterministic mock,
  supplier matching/ambiguity, duplicate heuristics + SHA-256 warnings.
- Payment-aware posting: unpaid -> AP; cash -> cash; company card ->
  card clearing; personal card/employee-paid -> employee payable.
- Merchant-only receipts no longer require a supplier master record
  (review trigger relaxed to require only a confirmed snapshot).
- Migrations `20260907000000_purchases_receipts_v10` and
  `20260907010000_purchase_merchant_review`.
- Docs `PURCHASES_RECEIPTS.md` + gap analysis; status/changelog updated.
- Tests: v0.10 unit 9, integration 6, browser E2E desktop/tablet/mobile.
- Production deploy (2026-09-03): backup + restore-verify PASS, code
  synced to `/opt/tilivo`, `remote-deploy.sh` PASS, migrations
  `20260907000000_purchases_receipts_v10` +
  `20260907010000_purchase_merchant_review` (15 -> 17), smoke PASS;
  other host services untouched.

## [0.9.0] - 2026-09-03

- VAT / ALV engine: semantic tax-code model (`direction`, `treatment`,
  reverse charge / intra-EU / export / import flags, deductibility,
  legal-notes templates, `is_system`), effective-date rate history and
  idempotent Finnish statutory seed (25.5 % / 13.5 % / 10 % / 0 % / exempt /
  EU / export / import / RC / construction RC).
- Central `vatEngineService` with deterministic rounding; sales and purchase
  posting consume engine results through the Accounting Core; journal lines
  freeze tax metadata (code, treatment, rate, base, tax, deductible split,
  leg type, reporting classification, legal note).
- Construction reverse-charge invoices carry the required wording
  (§ 8 c AVL / Art. 199) and do not create ordinary output VAT.
- Credit notes / purchase corrections invert VAT; period lock, idempotency
  and posting immutability preserved.
- VAT Summary API and UI (ALV kokkuvõte), tax-code admin view, tax.read /
  tax.manage / tax.report.read permissions and audit TAX_CODE.UPDATED.
- Sales/purchase UI per-line tax previews, VAT breakdown, deductibility and
  legal notes; invoice PDF tax summary and legal-note block.
- Migration `20260906000000_vat_engine_v09` (dev + test); upgrade test
  extended to v0.9; docs VAT_ENGINE.md + gap analysis.
- Tests: API 171/171 PASS (0 skipped), web 16/16 PASS,
  lint/typecheck/build PASS, Playwright VAT browser flows PASS
  (desktop/tablet/mobile).
- `V0.9 VAT / ALV ENGINE GATE: PASS`.
- Production deploy (2026-09-03): backup + restore-verify PASS, code
  synced to `/opt/tilivo`, `remote-deploy.sh` PASS, migration only
  `20260906000000_vat_engine_v09` (14 -> 15), VAT Playwright 6/6 PASS
  against https://tilivo.mrjaak.com; other host services untouched.

## [0.8.0] - 2026-09-03

- Accounting Core 1 audit + completion (vana tuum säilitatud, mitte
  ümberkirjutatud).
- Migration `20260905010000_accounting_core_v08`: `document_date`,
  `journal_lines.cost_center/project_code`, rea CHECK-id, opening-balance
  unikaalsus, dimensiooniindeksid, reversal-mirror dimensioonidega.
- Opening balances: `POST /api/v1/opening-balances`, audit
  `OPENING_BALANCE.POSTED`, duplikaaditõrge ACC-004, UI vaheleht „Algsaldod“.
- Reversal-linkid (`reversal_of_entry_id`, `JOURNAL_REVERSAL`) ja ostu
  korrektsiooni sama seos.
- Kontode aktiivsus: `PATCH /api/v1/accounts/:id` + UI activate/deactivate;
  mitteaktiivne konto blokeerib postituse.
- Journal UI: source-veerg, detailvaade, konto filter, kokkuvõtted/vahe,
  tasakaalustamata drafti Post keelatud, perioodi kinnitused, mobiilne
  stack/scroll.
- Tests: API 144/144 PASS (0 skipped, v0.8 integration 7), web 12/12,
  Playwright accounting-v08 9/9 PASS (desktop/tablet/mobile), lint/typecheck/
  build PASS.
- Production deploy (2026-09-03): backup enne; `remote-deploy.sh` PASS;
  migratsioon ainult `20260905010000_accounting_core_v08` (13 -> 14);
  production smoke PASS; teised serveriteenused puutumata.
- `V0.8 ACCOUNTING CORE 1 GATE: PASS` (lokal + production deploy).

## [0.7.5 gate closure] - 2026-09-03

- Migration `20260905000000_business_registry` valideeritud puhtal kohalikul
  PostgreSQL 17-l (dev + test DB, 13 migratsiooni; andmeid ei kustutatud).
- Integration tests: kogu API suite 137/137 PASS (fresh test DB),
  registry integration 9/9 PASS, 0 skipped; upgrade-test täiendatud v0.7.5
  registry tabeli/veergude/õiguste kontrolliga.
- Live PRH YTJ v3 smoke PASS: Y-tunnus 0112038-9 (Nokia Oyj), nimeotsing
  "Nokia" (mitu tulemust), not-found 9999990-9; mapping ühtib test-fixturega.
- Browser QA: Playwright registry spec 9/9 PASS desktop/tablet/mobile -
  kliendi/tarnija otsing, autofill, edit-eelsäilitus, overwrite-kinnitus,
  registry-unavailable fallback käsitsi sisestusega.
- Audit/persistents QA: CUSTOMER.REGISTRY_IMPORTED/REFRESHED ja
  SUPPLIER.REGISTRY_IMPORTED logitud; business_parties registry metadata +
  snapshot salvestatud; cache-tabelis üks kirje korduvate otsingute kohta.
- Kvaliteedikontroll: lint PASS, typecheck PASS, build PASS.
- Production deploy (2026-09-03): backup enne; kood sünkroniseeritud
  `/opt/tilivo`; `remote-deploy.sh` PASS (api/web/worker rebuilt);
  migratsioon ainult `20260905000000_business_registry` (12 -> 13);
  production smoke PASS; teised serveriteenused puutumata.
- `V0.7.5 BUSINESS REGISTRY GATE: PASS`.

## [0.7.5] - 2026-09-03

- Business registry integration (PRH YTJ open data v3, Finland) - reusable
  `BusinessRegistryProvider` + `BusinessRegistryService` + client-side
  provider abstraction; ei sõltu konkreetsest riigist.
- Y-tunnus normaliseerimine/kontrollsumma, VAT-kuju (FI + 8 numbrit) eraldi
  registreerimisstaatuse infost.
- API: `GET /api/v1/business-registry/search?q=...` ja
  `GET /api/v1/business-registry/companies/:businessId`; permission
  `registry.read` (kõik sisemised rollid).
- Kliendi/tarnija loomise + muutmise voog: registriotsing nime/Y-tunnuse
  järgi, mitme tulemuse valik, autofill, ülekirjutamise kinnitus, käsitsi
  sisestus jääb alati võimalikuks.
- Provinientsi hoidmine: `business_parties` lisa `registry_source`,
  `registry_source_id`, `registry_fetched_at`, `registry_snapshot`; audit
  `CUSTOMER/SUPPLIER.REGISTRY_IMPORTED/REFRESHED`.
- Cache: `business_registry_cache` (provider/lookup_key, TTL); rakendus-taseme
  rate limit provideri päringutele; UI debounce; PRH HTTP 429 -> REG-004.
- Turvalisus/resilients: timeout/DNS/HTTP/malformed kaardistus REG-003,
  kasutajasõbralikud sõnumid, response-validatsioon Zod-iga, serveripoolne
  provider (klient ei puutu PRH-i otse).
- Migration `20260905000000_business_registry.cjs` (andmeid ei kustuta);
  config env `BUSINESS_REGISTRY_*`.
- Docs: [`docs/BUSINESS_REGISTRY.md`](docs/BUSINESS_REGISTRY.md), status ja
  README uuendatud.
- Tests: business ID unit 5, provider unit 7, service unit 4, integration 9
  (fake provider, server test DB), frontend helper 3; lint/typecheck/build
  PASS lokal.

## [Roadmap 2026-09-03] - v0.7.5+ uus plaan

- Lisa [`ROADMAP.md`](ROADMAP.md): v0.7.5 (Business Registry Integration) jääb viimaseks "vana plaani"
  punktiks; alates v0.8 ehitatakse täisväärtuslikku Soome raamatupidamistarkvara (Accounting/ERP), mitte enam
  lihtsalt arvete programmi.
- Kaardistus juba ehitatud v0.4–v0.7 moodulite (dokumendid/audit, Accounting Core, Sales, Purchases) ja uue
  plaani versioonide vahel.
- README/IMPLEMENTATION_STATUS/arhitektuuridokument viitavad nüüd uuele ROADMAP.md-le; "Next step" on
  v0.7.5 Business Registry Integration.

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
