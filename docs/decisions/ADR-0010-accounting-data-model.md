# ADR-0010: Accounting data model

Date: 2026-09-02

## Status

Accepted

## Context

The accounting core needs a chart of accounts, fiscal years, accounting periods,
journals, tax codes, currencies and FX rates. Every accounting object belongs to
one tenant and must be isolated even if the application layer has a bug.

## Decision

Tenant-owned tables (`accounts`, `fiscal_years`, `accounting_periods`,
`tax_codes`, `fx_rates`, `journal_entries`, `journal_lines`,
`journal_reversals`) carry `tenant_id NOT NULL`, enable RLS and use
`FORCE ROW LEVEL SECURITY` with a single `tenant_all` policy backed by
`public.tilivo_tenant_id()`.

`currencies` is global reference data (ISO 4217 seed, no tenant owner).
`journal_sequences` is a tenant/fiscal-year keyed counter table with no RLS rows
semantics; only the runtime role can SELECT/INSERT/UPDATE it and the service
always writes the current tenant id.

Money columns use `NUMERIC` (28,8) for journals and FX and `NUMERIC(10,4)` for
tax rates. Account codes are text, not integers.

## Consequences

- Runtime SQL can never see another tenant's accounting rows and cannot insert a
  row claiming another tenant id.
- Application code still must set the transaction-scoped `app.tenant_id`; the
  shared `withTenantTransaction` helper does that for every write.
- Journal drafts must reference accounts/tax codes that exist in the same
  tenant; the draft service validates this before insert.
