# ADR-0013: Money handling and rounding

Date: 2026-09-02

## Status

Accepted

## Context

JavaScript binary floats cannot represent money safely. The database stores
`NUMERIC`; pg returns numeric columns as strings.

## Decision

- Storage: `NUMERIC(28,8)` for journal debits/credits and FX rates.
- Application arithmetic: `decimal.js` only; all DB numerics are converted via
  `new Decimal(String(value))` and responses carry strings so no float
  conversion happens on the authoritative path.
- FX conversion: the stored rate is used as `amount * rate`; when only the
  inverse pair exists, `1 / rate` is computed with `decimal.js` and the result
  is serialised as a decimal string.
- Minor-unit/display rounding happens in the UI only (`toFixed(2)`); the API
  never rounds authoritative values.
- A normal-balance convention is fixed: ASSET/EXPENSE debit-normal;
  LIABILITY/EQUITY/REVENUE credit-normal. Trial balance columns show balances
  on the normal side and abnormal balances on the opposite side.

## Consequences

- No float drift in posting, ledger balances or trial balance (covered by
  integration tests, including fractional and inverse-rate cases).
- A future currency subsystem must keep the same rule: no binary floats for
  authoritative money.
