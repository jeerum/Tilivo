# V0.5 Accounting Core Gate Report

Date: 2026-09-02

## 1. Schema

```text
accounts                      PASS
fiscal_years                  PASS
accounting_periods            PASS
journal_entries               PASS
journal_lines                 PASS
journal_reversals             PASS
tax_codes                     PASS
currencies                    PASS
fx_rates                      PASS
journal_sequences             PASS
RLS + FORCE RLS (8 tables)    PASS
runtime role no BYPASSRLS     PASS
```

## 2. Journal engine

```text
Draft creation                PASS
Controlled posting            PASS
Balanced invariant            PASS (service + DB trigger)
Entry numbering               PASS (atomic YYYY-######)
Posted immutability           PASS (API + direct runtime SQL denied)
Reversal                      PASS (mirrored lines, linked record)
Correction foundation         PASS (reverse + replacement draft)
Source linkage                PASS (source_type/source_id on entries)
```

## 3. Periods

```text
Open                           PASS
Soft close                     PASS
Close                          PASS
Reopen with reason             PASS
Close vs post race             PASS (serialised on period lock)
Posting into closed period     DENIED (PERIOD-002)
```

## 4. Money / FX

```text
NUMERIC storage                PASS
decimal.js arithmetic          PASS
No float drift                 PASS (integration + smoke)
FX rates CRUD                  PASS
FX conversion                  PASS (incl. inverse fallback)
Currencies reference           PASS
```

## 5. RLS / security

```text
Accounts/journal/lines/periods/fx isolation   PASS
Missing tenant context fail-closed            PASS
Cross-tenant insert denied (42501)            PASS
Runtime posted mutation denied                PASS
Permission matrix (Owner/Admin/Accountant/
Viewer/Employee)                              PASS
CSRF/auth guards                              PASS
Audit append-only regression                  PASS
```

## 6. Concurrency

```text
100 parallel posts -> 100 unique numbers      PASS
Double post -> exactly one transition         PASS
Reversal race -> exactly one reversal         PASS
Period close vs post race                     PASS
Audit chain under parallel writes             PASS
```

## 7. Invariants

```text
Debit == Credit on POSTED                     PASS
Reversal net effect zero                      PASS
Draft excluded from balances                  PASS
Posted affects balances                       PASS
Trial balance totals equal                    PASS
Account ledger running balance                PASS
```

## 8. API and desktop UI

```text
Accounts/fiscal years/periods                 PASS
Journals list/detail/post/reverse             PASS
Ledger + account ledger + trial balance       PASS
Tax codes, FX rates, currencies               PASS
Desktop UI /accounting (journal, chart,
periods, reports)                             PASS
ET/EN translations                            PASS
```

## 9. Upgrade and migrations

```text
Fresh accounting migration                    PASS
v0.4 -> v0.5 upgrade test (scratch DB)        PASS
Production v0.4 backup -> copy -> migrate     PASS
  (tenants 3, users 2, docs 1, audit 32 preserved;
   pgmigrations 7 -> 10)
Hardening migration                           PASS
Tax unique index migration                    PASS
```

Migrations applied to production:
`20260902220000_accounting_core`,
`20260903000000_accounting_hardening`,
`20260903010000_tax_codes_unique`.

## 10. Tests

```text
Local npm run test:ci                         PASS
  (lint, typecheck, API unit 25, web unit 6, builds)
npm audit (root/api/web)                      0 vulnerabilities
Server test DB full suite                     71/71 PASS
  - accounting core 9, upgrade 1, security 3
  - v0.2 auth 18, v0.3 tenant/RLS 6, v0.4 platform 6,
    unit/security/env/health 25
Playwright (production UI)                    8 PASS / 1 skip
  (skip: desktop project skips drawer test by design)
```

## 11. Production

```text
DB backup                                     PASS
Restore isolated + SHA-256 document verify     PASS
Production migrate (from v0.4)                 PASS (10/10)
DB/API/Web/Worker health                       PASS
Public HTTPS                                   PASS
Production accounting smoke                    34/34 PASS
Cross-tenant deny                              PASS (integration + smoke DB)
Audit events written live                      PASS
```

## 12. Existing services

```text
nginx/docker/mariadb/postgresql/postfix/
cloudflared/fail2ban/ssh                       active (unchanged)
wordgame containers                            8 days / up (unchanged)
multipower                                     4 weeks (unchanged)
nginx sites                                    baltik, locoforum.com,
  mrjaak.com, multipower, tilivo.mrjaak.com,
  wordgame-saas (unchanged)
```

## 13. GitHub

```text
repo:      https://github.com/jeerum/Tilivo
branch:    main
push:      done
```

## 14. Open risks

- MEDIUM (documented): the runtime role can in principle post a draft directly
  via SQL if it fabricates metadata and passes DB triggers; a SECURITY DEFINER
  posting function would close this. No API exposes this path.
- LOW: fiscal-year level close is not implemented yet (period level only).
- LOW: accounting UIs do not yet edit draft lines (create/repost flow only).
- INFO: tenant teardown with posted journals requires disabling accounting
  triggers under an admin session (used only for test-data cleanup).
- INFO: no production SMTP driver yet (pre-existing).

## 15. Final gate

```text
V0.5 ACCOUNTING CORE GATE: PASS
```

STOP - v0.6 Sales ei alustata.
