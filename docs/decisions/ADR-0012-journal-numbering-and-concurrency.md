# ADR-0012: Journal numbering and concurrency

Date: 2026-09-02

## Status

Accepted

## Context

Entry numbers must be unique per tenant/fiscal year and allocated at posting
time. Parallel posting from API workers must never produce duplicates or gaps
inside one fiscal year.

## Decision

`journal_sequences(tenant_id, fiscal_year_id, next_number)` starts at 2 and is
updated with a single atomic upsert:

```sql
INSERT INTO journal_sequences (tenant_id, fiscal_year_id, next_number)
VALUES ($1, $2, 2)
ON CONFLICT (tenant_id, fiscal_year_id)
DO UPDATE SET next_number = journal_sequences.next_number + 1
RETURNING next_number - 1 AS number
```

The returned value is formatted as `YYYY-######` (`2026-000001`). Number
allocation happens inside the posting transaction together with the entry and
period row locks.

## Consequences

- 100 concurrent postings produce 100 unique contiguous numbers (verified by an
  integration test).
- Double post is impossible: the second transaction observes `POSTED` and fails
  with `JRN-002`.
- Reversal numbering uses the same sequence/flow, so reversal entries interleave
  with manual posts atomically.
