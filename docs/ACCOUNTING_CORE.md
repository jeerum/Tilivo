# Tilivo Accounting Core (v0.5)

## Purpose

The v0.5 accounting core provides the ledger foundation later modules
(invoicing, purchases, banking) will post into. The ledger is the source of
truth: every report reads `POSTED` journal entries/lines only.

## Core invariants

1. Every `POSTED` journal has at least two lines and `sum(debit) == sum(credit)`.
2. `POSTED`/`REVERSED` entries and lines are immutable (service + DB triggers).
3. Corrections happen via a controlled reversal that mirrors the original lines;
   the original row stays as history.
4. Drafts never affect balances.
5. Money uses NUMERIC + decimal.js; no binary float arithmetic on the
   authoritative path.
6. Every tenant-owned accounting row is protected by FORCE RLS.

## Data model

Tenant-owned: `accounts`, `fiscal_years`, `accounting_periods`, `tax_codes`,
`fx_rates`, `journal_entries`, `journal_lines`, `journal_reversals`.
Global reference: `currencies`. Counter: `journal_sequences`
(tenant_id, fiscal_year_id) with atomic upsert numbering.

Statuses:

- journals: `DRAFT` -> `POSTED` -> `REVERSED`;
- periods: `OPEN`, `SOFT_CLOSED`, `CLOSED`; reopen stores actor + reason.

## Posting flow

`postJournal(entryId, actor, tenant)` inside one transaction:

1. lock entry, require DRAFT;
2. lock period for the business date, require OPEN;
3. validate lines (>=2, same-tenant active accounts, balanced);
4. allocate `YYYY-######` number atomically;
5. mark POSTED with number, actor, timestamps.

Reversal runs the same posting flow for a new entry whose lines mirror the
original, then registers `journal_reversals` and marks the original `REVERSED`.

## Permissions

| Action | Owner/Admin | Accountant | Viewer/Employee |
| --- | --- | --- | --- |
| read | yes | yes | no |
| create draft | yes | yes | no |
| post | yes | yes | no |
| reverse | yes | no | no |
| close/reopen period | yes | no | no |
| manage chart/tax/fx | yes | no | no |

## Money and FX

- Journal lines store debits/credits in NUMERIC(28,8); journal entries carry
  currency and optional exchange rate.
- FX rates are tenant-owned, dated, source-tagged and unique per
  (base, quote, date, source). Conversion uses the newest rate on or before the
  requested date, with inverse fallback.
- Rounding is display-only; the API returns decimal strings.

## Reporting

- Journal list/detail with lines.
- General ledger (posted lines, filters, totals, pagination).
- Account ledger statement: opening balance, movements with running balance,
  closing balance.
- Trial balance: account balances on normal sides with equal debit/credit
  totals when balanced.

## Period rules

Posting requires an OPEN period covering the business date. Missing period,
soft-close and close are denied; reopen needs `period.reopen` and a reason.
Close vs post races are serialised on the period row lock.

## UI

The `/accounting` workspace (desktop-first) offers journal creation/posting/
reversal, chart of accounts, period management and reports. ET/EN supported;
the backend remains authoritative for balance and permission decisions.

## Tests

See `apps/api/tests/accounting.integration.test.ts`,
`apps/api/tests/accounting_security.integration.test.ts` and
`apps/api/tests/accounting_upgrade.integration.test.ts`. Coverage includes:

- v0.4 -> v0.5 upgrade on a scratch database with data preservation;
- DB immutability of posted entries/lines (direct runtime access);
- double post, 100-way parallel numbering, reversal race, period close vs post;
- role permission matrix and cross-tenant RLS isolation;
- tax/FX CRUD + conversion;
- ledger, account ledger, trial balance and journal views;
- draft exclusion from balances.

## Backups and deployment

Backups cover the database and object storage; restore is tested in isolation
before production migration. Migrations are forward-only files under
`apps/api/migrations`; v0.5 adds:

- `20260902220000_accounting_core`
- `20260903000000_accounting_hardening`
- `20260903010000_tax_codes_unique`
