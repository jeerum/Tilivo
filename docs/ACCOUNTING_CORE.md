# Tilivo Accounting Core (v0.5 -> v0.8)

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

## Audit events

Accounting actions write to the existing v0.4 audit trail:
`ACCOUNT.CREATED`, `JOURNAL.DRAFT_CREATED`, `JOURNAL.POSTED`,
`JOURNAL.REVERSED`, `PERIOD.SOFT_CLOSED`, `PERIOD.CLOSED`,
`PERIOD.REOPENED`, `TAX_CODE.CREATED`, `FX_RATE.CREATED`. Metadata carries
entry numbers and object ids only - never secrets or document contents.
Audit appends are serialised before the transaction starts so the hash chain
stays valid under parallel writes.

## v0.8 additions

### Journal model

- `journal_entries.document_date` (nullable) keeps the original document date
  when relevant.
- `journal_lines.cost_center` and `project_code` are nullable dimension
  readiness fields. No projects table exists yet; later modules can promote
  them to real references without a schema-breaking redesign.
- DB CHECKs enforce non-negative amounts and debit/credit exclusivity per
  line; posting additionally rejects zero-amount lines.
- A reversal entry now sets `source_type = JOURNAL_REVERSAL`,
  `source_id` = original entry id and `reversal_of_entry_id`; purchase
  correction reversals set `reversal_of_entry_id` too. The DB mirror trigger
  includes dimension fields.

### Opening balances

`POST /api/v1/opening-balances` creates and posts an auditable
`OPENING_BALANCE` journal entry in one transaction (date, note, balanced
lines). Rules:

- posting requires `journal.create` + `journal.post` and an OPEN period;
- one posted opening balance per tenant per business date (partial unique
  index; reversed entries do not block a new one);
- balances are ordinary journal lines - no hidden magic balances;
- audit event `OPENING_BALANCE.POSTED` records date, entry number and note.

### Chart of accounts

`PATCH /api/v1/accounts/:id` supports `name`, `type` (normal balance is
derived) and `is_active`. Inactive accounts block posting at the service
layer. UI has activate/deactivate actions.

### UI

- Accounting workspace gained an "Opening balances" tab, journal detail view
  (source type/id, reversal links, lines with dimensions), source column in
  the journal list, account search filter, debit/credit/difference totals and
  disabled Post for unbalanced drafts.
- Period close/reopen asks for confirmation.
- Mobile: journal/entry tables scroll horizontally in wrappers and journal
  line rows stack vertically on narrow screens.

### Money display

`apps/web/src/lib/money.ts` sums display totals in integer cents to avoid
float drift; backend remains the authoritative NUMERIC/decimal.js path.

## Backups and deployment

Backups cover the database and object storage; restore is tested in isolation
before production migration. Migrations are forward-only files under
`apps/api/migrations`; v0.5 adds:

- `20260902220000_accounting_core`
- `20260903000000_accounting_hardening`
- `20260903010000_tax_codes_unique`
