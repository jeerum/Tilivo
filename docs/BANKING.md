# Banking v0.13

Tilivo Banking imports bank statements and turns each immutable imported row into an explicit reconciliation decision before Accounting Core posting.

## Scope

- Bank accounts: normalized IBAN, BIC, currency, ledger mapping, default and active state.
- File imports: CSV and CAMT.053 (`FILE_IMPORT` only), preview, repeated-file rejection and duplicate fingerprints.
- Matching: deterministic reference, invoice number, amount and counterparty signals. Suggestions never post automatically.
- Reconciliation: partial invoice payments, multi-invoice splits and visible customer/supplier residuals.
- Classifications: bank fee, interest income/expense, card clearing, internal transfer and generic ledger account.

Posting is delegated to Accounting Core. Sales payments reduce AR; purchase payments reduce AP; configured mappings drive fees, interest and clearing. Period locks are respected and source IDs make retries idempotent. Imported source fields remain traceable, and permissions, tenant isolation, RBAC and audit events apply to Banking endpoints.

## Using the UI

Open **Banking** from the main navigation. Set up a bank account and ledger account, then configure mappings in Banking settings. In Import, select an account and CSV/CAMT.053 file, inspect parser/date/row/totals/duplicates/warnings, and confirm. Transactions open in a detail drawer where suggestions can be accepted, candidates chosen, or allocations entered manually. The remaining amount must be zero before Reconcile / post is enabled.

Import history links to the account-filtered transaction list. Reconciliation shows status counts and inflow/outflow summary. The flows are usable at desktop, 768px tablet and 390px mobile widths without hover-only actions.

## Boundaries

v0.13 does not connect to live Open Banking providers, store bank credentials or initiate payments. `OPEN_BANKING` and payment initiation remain future-ready boundaries. All development and E2E fixtures must be synthetic.
