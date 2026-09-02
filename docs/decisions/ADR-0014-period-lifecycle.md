# ADR-0014: Period lifecycle and reopen policy

Date: 2026-09-02

## Status

Accepted

## Context

Posting must be denied after a period closes. Periods also need a soft-close
state and a controlled reopen with an audit trail.

## Decision

`accounting_periods.status` transitions:

- `OPEN` – posting allowed;
- `SOFT_CLOSED` / `CLOSED` – posting denied (409 `PERIOD-003`/`PERIOD-002`);
- reopen requires the `period.reopen` permission and a reason >= 5 characters;
  actor and timestamps are recorded (`reopened_at`, `reopened_by`,
  `reopen_reason`).

Posting locks the period row before checking status, so a concurrent
close/post race is serialised: either the post commits first and close still
succeeds, or close commits first and the post is denied. There is no
intermediate state where an entry is posted into a closed period.

## Consequences

- Reopen is an explicit, auditable event rather than a silent flag flip.
- Fiscal-year-level close remains future work; v0.5 manages periods inside one
  fiscal year.
