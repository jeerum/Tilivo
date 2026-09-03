# v0.13 Banking — gap analysis and architecture

Checked: 2026-09-03, HEAD `c8f4da2` (v0.12 committed). Working tree clean.

## Audit result

| Requirement | Status | Notes |
|---|---|---|
| Sales payment records | EXISTS | `sales_invoice_payments` (manual AR readiness), no bank source linkage yet |
| Purchase payment allocations | MISSING | purchases have `payment_method/payment_status` only; no per-document payment records |
| Bank account model | MISSING | only `sales_settings.bank_iban/bic/holder` for PDF display |
| Bank statement import | MISSING | no import pipeline; document upload infra exists (documents/document_versions/storage) |
| CAMT.053 / CSV parsers | MISSING | e-invoice XML parsers exist as a pattern; no bank parsers |
| Matching engine | MISSING | sales reminders/late-interest pure logic exists; no bank-to-invoice matching |
| Reconciliation model | MISSING | no allocation/difference/status model |
| Accounting posting | EXISTS | Accounting Core with period lock, idempotent source linkage (`source_type/source_id`), journal sequences |
| AI/provider abstractions | EXISTS | `ExpenseClassificationProvider` mock pattern can be mirrored for bank suggestions |
| Audit hash chain | EXISTS | action union must be extended |
| RBAC/tenant isolation | EXISTS | add `banking.*` permissions to `TENANT_PERMISSIONS` + migration |
| File upload/import | PARTIAL | object storage + documents; multipart route pattern in purchases |
| Outbox/worker | EXISTS | can be reused for async import/post if needed |
| Open Banking / payment initiation | MISSING (readiness only) | provider abstraction planned, no live connectivity |

## Core principle

Imported bank data is immutable source evidence. Flow:

`bank transaction → matching/allocation → reconciliation decision → Accounting Core posting`

The imported row is never treated as a journal line directly.

## Data model (planned migration `20260911000000_banking_v13`)

### `bank_accounts`
id, tenant_id, name, iban (normalized, unique per tenant), bic, currency,
bank_name, ledger_account_id (composite FK to accounts), is_active, is_default,
provider_id/external_id, source readiness, created_at/updated_at.
Default rule: at most one active default per tenant.

### `bank_statement_imports`
id, tenant_id, bank_account_id, file_name, file_sha256 (unique per tenant),
parser_type (`GENERIC_CSV`/`CAMT053`), status, row_count, imported_count,
duplicate_count, error_count, warnings jsonb, opening_balance/closing_balance
optional, imported_by, created_at.

### `bank_transactions`
id, tenant_id, import_id, bank_account_id, booking_date, value_date,
accounting_date (default booking date), amount numeric(28,8) (signed or
separate direction), currency, direction, counterparty_name, counterparty_iban,
message, payment_reference (normalized), bank_transaction_id, archive_reference,
original_row jsonb, fingerprint (unique per tenant where reliable), status
(UNMATCHED/SUGGESTED/PARTIALLY_MATCHED/MATCHED/POSTED/IGNORED),
ignored_reason, allocated_total, created_at. Immutable after import except
status/allocations/accounting_date.

### `bank_transaction_allocations`
id, tenant_id, transaction_id, kind
(SALES_INVOICE/PURCHASE_INVOICE/BANK_FEE/INTEREST/EXPENSE/TRANSFER/CARD_CLEARING/OTHER),
document_id, amount, ledger_account_id, description, project_code,
cost_center, tax_code_id optional, posted_journal_entry_id nullable, created_by.
Unique `(tenant_id, transaction_id, kind, document_id)` where document applies.

### `bank_account_balances` (optional readiness)
import_id, opening, closing, statement_date.

## Import pipeline

1. Validate file (extension secondary, size limit, content sniffing).
2. Hash file (SHA-256); reject repeated file per tenant.
3. Parse to normalized rows via `BankStatementParser` implementations:
   - `GenericCsvBankStatementParser`: UTF-8, comma/semicolon, header alias
     matching (FI/EN/ET aliases), configurable mapping.
   - `Camt053BankStatementParser`: fast-xml-parser with external entities
     disabled (XXE-safe), extracts CdtDbtInd, amount, booking/value date,
     refs, remittance, counterparty, IBAN, bank transaction ids.
4. Fingerprint duplicate check per account:
   - strongest: bank_transaction_id
   - fallback: account + booking date + amount + reference + counterparty
5. Create import batch + normalized transactions; return summary
   (parsed rows, imported, duplicates, warnings, totals).

## Matching engine

Deterministic score (layered, exact reference dominates AI):

Incoming (sales):
- exact normalized FI/RF reference: 100
- invoice number in message: +50
- exact open amount: +25
- customer IBAN: +20
- customer name: +10

Outgoing (purchase):
- exact normalized reference: 100
- supplier invoice number in message: +50
- supplier IBAN: +30
- exact amount: +25
- supplier name: +10

Rules:
- exact reference match is accepted as the suggestion and bypasses AI;
- ties/ambiguity > threshold yield candidate list, never silent auto-select;
- no auto-posting; explicit user accept required.

AI (banking suggestion provider) may add invoice/supplier/account/split hints
after deterministic layer. Mirror `ExpenseClassificationProvider` mock.

## Allocation and posting

Confirming an allocation posts through Accounting Core with source type
`BANK_TRANSACTION` and source id = transaction id, reusing journal
idempotency/period lock:

- sales incoming: Dr Bank / Cr AR (+ customer unallocated for overpayment)
- purchase outgoing: Dr AP / Cr Bank
- bank fee: Dr fee expense / Cr Bank
- interest in: Dr Bank / Cr interest income
- internal transfer: Dr Bank B / Cr Bank A (single posted entry)
- card clearing: Dr bank / Cr card clearing account (receipts stay untouched)

Reconciliation exactness: sum(allocations) == abs(transaction amount); any
residual remains visible as unresolved difference. Posting retries are
idempotent (unique journal link per allocation/transaction).

## Sales/purchase coexistence

Existing `sales_invoice_payments` gains `source`/`bank_transaction_id` to
record BANK_IMPORT origin without rewriting v0.12 history. Purchases get a
new `purchase_invoice_payments` table mirroring sales, plus AP open balance
fields already present on purchase documents.

## Permissions

`banking.read`, `banking.import`, `banking.match`, `banking.post`,
`banking.accounts.manage`. Owner/Admin/Accountant get full normal banking;
Employee read-only (policy decision); migration + `TENANT_PERMISSIONS` update.

## Audit events (hash chain)

`BANK_ACCOUNT.CREATED/UPDATED`, `BANK_IMPORT.CREATED`,
`BANK_TRANSACTION.IMPORTED`, `BANK_MATCH.ACCEPTED`,
`BANK_TRANSACTION.SPLIT`, `BANK_TRANSACTION.POSTED`,
`BANK_TRANSACTION.IGNORED`, `BANK_RECONCILIATION.COMPLETED`.

## UI (planned)

Banking section with tabs: Transactions, Import, Bank accounts,
Reconciliation, Import history. Transaction rows show suggestion +
confidence + reason with Accept/Change/Split/Ignore; allocations editor with
live difference; mobile 390/768 flows.

## Test fixtures (synthetic)

Finnish CSV, CAMT.053 sample, exact sales/purchase references, partial and
batch payments, bank fee, internal transfer, unknown transaction. No real
banking data.

## Boundaries

- No live Open Banking connectivity, no payment initiation, no loan
  amortization engine in v0.13.
- Open Banking remains provider-ready abstraction only.

## Implementation note

The backend foundation described above is now present, and the web Banking workspace is implemented in `apps/web/src/app/BankingPage.tsx`. The final gate still needs a configured test database and authenticated synthetic Playwright session to verify all integration and browser scenarios. Live Open Banking and payment initiation remain out of scope.

## Open questions to confirm before implementation

1. Accounting date policy default: booking date, value date override allowed
   before posting.
2. Employee banking permissions: read-only vs none (recommend read-only).
3. Import preview required vs post-import summary acceptable (recommend
   post-import summary first, preview later).
