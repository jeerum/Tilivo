# Implementatsiooni staatus

## Current version

**v0.5 (Accounting Core) - code + integration tests done; production
backup/deploy/smoke and gate report remaining**

v0.4 gate: **PASS**. Security review: v0.2 CRITICAL/HIGH 0 open
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

### Bugs found and fixed on top of 6cf0cd7

- Reversal never marked the original entry REVERSED (reversal endpoint failed
  once DB hardening was enforced).
- First entry number started at `000000` instead of `000001`.
- No INSERT trigger on `journal_entries`; POSTED inserts and posted-line inserts
  were possible at DB level.
- New tenants' Owner/Admin/Accountant roles lacked the accounting permissions
  (fixed in builtin role seeds).
- Tax code uniqueness index was not unique (new migration adds it).

## In progress

- v0.5 gate: backup/restore verification, production migrate/deploy, production
  accounting smoke, full regression, ADR/docs final pass, git push.

## Not started

- v0.4 Audit & compliance edasiarendus
- v0.6 Sales / arveldus (ei alustata enne v0.5 gate PASS)
- Production SMTP driver

## Tests

```text
Local: API lint/typecheck/unit 25 PASS, web lint/typecheck/unit 6 PASS,
       web build PASS
Server test DB (fresh reset each run), accounting subset: 13/13 PASS
  - v0.4 -> v0.5 upgrade migration on scratch DB (data preservation, RLS,
    grants, triggers)
  - posted immutability direct runtime SQL
  - double post + reversal race + period close vs post race
  - 100 parallel posts -> 100 unique contiguous numbers
  - tax/FX CRUD + conversion
  - journal/ledger/account-ledger/trial-balance views
  - role permission matrix + cross-tenant RLS + auth/CSRF guards
Full v0.2/v0.3/v0.4 regression suite: runs during full-regression step.
```

## Deployment status

- `/opt/tilivo`, containers `tilivo-*`, ports 127.0.0.1:3100/3101; public
  https://tilivo.mrjaak.com (Let's Encrypt + isolated nginx vhost).
- Production DB is still at the v0.4 migration set (7 migrations). v0.5
  migrations (`20260902220000_accounting_core`,
  `20260903000000_accounting_hardening`, `20260903010000_tax_codes_unique`) are
  applied only after backup/restore verification.

## Next step

Backup/restore -> production deploy + accounting smoke -> full regression ->
existing services -> git push -> final v0.5 gate report.
