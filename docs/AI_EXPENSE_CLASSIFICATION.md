# AI Expense Classification (v0.11)

## Provider architecture

- `ExpenseClassificationProvider` abstraction returns a structured
  `RawClassificationSuggestion`.
- Active provider: `mock-ai` (`EXPENSE_AI_DRIVER=mock` default) with model
  `deterministic-v1`; no live AI is required for CI or local QA.
- Provider output is validated with Zod (`rawSuggestionSchema`) and mapped to
  tenant-owned IDs by the service. Malformed output is rejected cleanly and
  documents remain fully usable.

## Classification inputs

- OCR fields (name/value/confidence) from `purchase_invoice_extractions`.
- Document type, merchant/supplier fields, date, currency, totals, VAT,
  payment method, description, category.
- Active tenant expense/asset accounts and effective purchase tax codes for
  the document date.
- Supplier history: recent posted purchases with expense account, tax code,
  deductibility and payment method (deterministic signal).

## Structured output

Suggestions are code/rate based and then resolved to tenant IDs:

- expense account
- VAT/tax code
- deductibility %
- payment method
- description/category
- project/cost-center readiness

Confidence is normalized to `0..1`; field-level confidences and concise
reasons accompany every suggestion. No chain-of-thought is stored or shown.

## Validation

- Suggested accounts must exist in the tenant and be active.
- Suggested tax codes must be valid for the document date, purchase
  direction and tenant.
- Cross-tenant IDs are rejected server-side.
- Provider failure (mock malformed/timeout scenarios) returns a clean error;
  OCR/manual flow continues.

## Fingerprint / caching

`inputFingerprint` is a SHA-256 of classification-relevant document fields.
Repeated classification with an unchanged fingerprint returns the latest
READY result instead of rerunning the provider.

## User control

- Classification is explicit (button), never automatic.
- UI shows suggestion cards with confidence and per-field Accept buttons,
  plus Apply all and Re-run.
- Applying updates the editable purchase draft (header and line fields) and
  records accepted/final outcome on the run; posted documents cannot be
  reclassified/applied.
- User manual edits are never silently overwritten (apply is explicit).

## Privacy / injection

- Only the minimum document signals are sent to the provider.
- Document text is treated as data: injected instructions in receipt text
  cannot select arbitrary accounts (structured validation still applies).
- No secrets or unrelated tenant data are included.

## Audit

Classification lifecycle events append to the existing hash chain:
`PURCHASE.CLASSIFICATION_REQUESTED/COMPLETED/FAILED/APPLIED`.

## Permissions

- `purchase.classify`: Owner/Admin/Accountant/Employee.
- `purchase.classification.apply`: Owner/Admin/Accountant.
- Viewer remains read-only.

## API

```text
POST /api/v1/purchases/:id/classification          # run classification
GET  /api/v1/purchases/:id/classification          # latest run
POST /api/v1/purchases/:id/classification/apply    # apply chosen fields
```

## Tests

- Unit: structured output validation, malformed provider, mock office/
  software/fuel suggestions, fingerprint stability/change, injection-as-data.
- Integration: classify + persist + cache, field application, categories,
  cross-tenant rejection, provider failure fallback, permissions.
- Browser E2E desktop/tablet/mobile: classify receipt, show confidence,
  apply, post.

## Known limitations

- Live LLM provider is not configured; adding one only requires a new
  `ExpenseClassificationProvider`.
- Project suggestions are data-ready but no project table exists yet.
- Multi-line per-line suggestions are represented by line descriptions and
  OCR rates; a document-level default applies to editable lines.
