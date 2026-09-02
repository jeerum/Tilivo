# ADR-0011: Journal posting invariants

Date: 2026-09-02

## Status

Accepted

## Context

Accounting truth lives in posted journals. An unbalanced posted entry would
corrupt every report, and editable history breaks auditability. The defence
must survive a direct runtime-role SQL attempt, not only the API.

## Decision

Posting is a single controlled service path (`postJournal` /
`postEntryInTransaction`):

1. lock the draft entry `FOR UPDATE`;
2. require status `DRAFT`;
3. lock the accounting period `FOR UPDATE` and require `OPEN`;
4. validate >= 2 lines, active same-tenant accounts and
   `sum(debit) == sum(credit)` with `decimal.js`;
5. take the fiscal-year sequence number atomically in the database;
6. set `POSTED`, `entry_number`, `posted_by`, `posted_at`, `posting_date`.

DB-level protection:

- `journal_entries` may only be inserted as `DRAFT`;
- a `DRAFT -> POSTED` update requires number/post metadata and is re-checked by
  an AFTER UPDATE balance trigger;
- `POSTED`/`REVERSED` entries and lines reject UPDATE/DELETE and line INSERT;
- `POSTED -> REVERSED` is allowed only with a linked `journal_reversals` row
  whose reversal entry mirrors every original line (account, description,
  debit/credit swapped, tax code), same currency and same business date;
- journal lines immutable trigger also covers INSERT.

Lock ordering is always entry-first, then period, so concurrent post/reverse on
the same entry cannot deadlock.

## Consequences

- Direct runtime SQL cannot edit or delete posted entries or mark them reversed
  without a real mirrored reversal.
- Direct SQL can still *post a draft with metadata* if it can guess unique
  numbers and pass the balance trigger; the runtime role is a server-side
  credential, so this residual path is documented as acceptable for v0.5 (a
  SECURITY DEFINER posting function would close it entirely and is noted as
  future hardening).
- Corrections are made by reversal + replacement entry, never by silent edit.
