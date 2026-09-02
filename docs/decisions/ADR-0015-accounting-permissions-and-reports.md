# ADR-0015: Accounting permissions and reporting API

Date: 2026-09-02

## Status

Accepted

## Context

Accounting actions need finer permissions than the v0.4 document model and
reports must be computed server-side from posted entries.

## Decision

Permissions:

- `accounting.read` – read any accounting list/report;
- `journal.create` / `journal.post` – draft and post;
- `journal.reverse` – reverse posted entries;
- `period.manage` / `period.reopen` – close and reopen periods;
- `chart.manage` – accounts, fiscal years, periods, tax codes and FX rates.

Owner and Admin get all of them; Accountant gets read/create/post; Viewer and
Employee get none. Builtin role seeds and the migration grant statements stay in
sync.

Reporting:

- `GET /journals` and `GET /journals/:id` return entries with lines;
- `GET /ledger` returns posted lines with account context, filters and totals;
- `GET /accounts/:id/ledger` returns opening balance, movements, running
  balance and closing balance;
- `GET /reports/trial-balance` aggregates posted lines per account, shows
  balances on normal sides and reports whether debit/credit totals are equal.

All report endpoints require `accounting.read` and run inside the tenant
transaction so RLS applies.

## Consequences

- The UI can be built directly on these endpoints; reports remain server-side
  truth.
- Drafts never appear in ledger/trial balance; REVERSED originals are excluded
  from balances and their POSTED reversal entries neutralise the effect.
