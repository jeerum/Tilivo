# Time Tracking v0.15

## Verification

The isolated v0.15 integration suite and Playwright flow pass on desktop,
tablet (768px) and mobile (390px). The browser flow covers employee setup,
work and absence entry, timesheet creation and submission.

Time entries are tenant-scoped and employee-linked. Canonical duration and breaks are stored as integer minutes; work and absence buckets are explicit. Entries support project/worksite, cost center, source and employment readiness fields.

Monthly timesheets support draft, submit, approve, reject, lock and reopen actions. Approval history is retained and all lifecycle actions are audited. Payroll, tax, holiday, mileage and Tulorekisteri calculations are intentionally outside v0.15.
