# v0.9 VAT / ALV Engine — gap analysis

Audit date: 2026-09-03 (before any v0.9 code change).

Scope: current tax code model, accounting posting engine, sales invoice
logic, purchase invoice logic, invoice PDF, permissions/audit, and UI tax
handling in the repo.

## Requirement map

### Tax code model

| Requirement | State |
| --- | --- |
| tenant-scoped `tax_codes` with code/name/country/rate/effective dates/active | EXISTS (`accounting_core` + `tax_codes_unique`) |
| legacy `type` and `reporting_mapping` snapshots | EXISTS |
| semantic treatment (domestic/reduced/0%/exempt/EU/export/import/RC/construction RC/own use) | MISSING (`type` is a legacy display snapshot; cannot be overloaded) |
| direction (SALES/PURCHASE/BOTH) | MISSING |
| reverse_charge / intra_EU / export / import flags | MISSING |
| deductible % (100/0/custom) | MISSING |
| legal-note template per tax code (localised) | MISSING |
| system vs tenant-custom codes | MISSING |
| effective-date rate history rows | PARTIAL (schema supports `effective_from/to`; no seeded history) |
| tenant-specific account mappings for output/input/RC | PARTIAL (sales_settings + purchase_settings hold the accounts; no per-code mapping table) |

### Calculation

| Requirement | State |
| --- | --- |
| reusable central VAT engine (not `if rate === X`) | MISSING |
| deterministic decimal.js rounding | EXISTS in line helpers, duplicated for sales/purchases |
| per-line tax code with mixed rates on one invoice | EXISTS (line `tax_code_id` + snapshots) |
| distinct ZERO_RATED / EXEMPT / REVERSE_CHARGE | PARTIAL (purchase posting special-cases `type === REVERSE_CHARGE`; sales treats anything non-RC as taxable by rate) |
| construction reverse charge (no normal output VAT + invoice wording) | PARTIAL (can be represented as RC type; no legal wording, no classification, no buyer-identifier note) |
| EU goods vs EU services, distinct codes/classifications | MISSING |
| export/import classification | MISSING |
| purchase deductibility (full/partial/none) with expense capitalisation | MISSING |
| self-assessed output + deductible input for EU/RC acquisitions | PARTIAL (purchase `REVERSE_CHARGE` path adds both sides; not semantic and rate-less in draft totals) |

### Posting / ledger

| Requirement | State |
| --- | --- |
| posting through accounting core (no duplicate ledger logic) | EXISTS |
| AR/Revenue/Output VAT and Expense/Input VAT/AP patterns | EXISTS |
| journal line tax snapshots (`tax_code_id`, `applied_tax_rate`, `tax_snapshot`) | PARTIAL (code/type string only) |
| immutable journal lines; no mutation of history when master data changes | EXISTS (DB + service triggers) |
| tax treatment/classification/deductible amounts frozen on journal lines | MISSING |
| credit notes invert VAT | EXISTS (sales full credit via inverse journal; purchase correction via reversal) |
| period lock + idempotency | EXISTS (core posting flow + source linkage) |
| VAT summary preview by period/classification | MISSING |

### Output

| Requirement | State |
| --- | --- |
| per-line tax selection with meaningful labels | PARTIAL (dropdown shows `code rate%` only) |
| net/VAT/gross per line and totals | PARTIAL (draft editor computes; RC/EU semantics not respected in UI preview) |
| VAT breakdown by code/rate | MISSING |
| invoice legal text from tax code (RC, EU, export, exempt) | MISSING |
| PDF shows rates/totals and legal wording | PARTIAL (rates/totals only) |
| mobile usable | PARTIAL (existing tables wrap; new controls must follow same rules) |

### Rules / data / governance

| Requirement | State |
| --- | --- |
| official sources documented with retrieval date | MISSING (roadmap links exist; no dated rule log) |
| seeded default Finnish tax-code set (idempotent) | MISSING |
| new tenants receive defaults | MISSING (tenant creation seeds roles only) |
| migration preserves existing data | EXISTS as a principle; new migration must follow it |
| restricted editing of statutory codes | MISSING |
| tax.read / tax.manage / tax.report.read permissions | MISSING |
| audit of tax-code/VAT configuration changes | PARTIAL (`TAX_CODE.CREATED` exists; no `TAX_CODE.UPDATED` event) |

### Tests / documentation

| Requirement | State |
| --- | --- |
| v0.5–v0.8 regression suite | EXISTS (144 API + web + Playwright baselines) |
| v0.9 VAT unit/integration/E2E tests | MISSING |
| docs/VAT_ENGINE.md | MISSING |
| README/status/changelog updated for v0.9 | MISSING |

## Architecture decision for v0.9

- Keep the existing tenant-local `tax_codes` rows (already the repo pattern)
  and add semantic columns rather than creating a parallel global registry.
  Account-level VAT configuration stays in the existing tenant
  `sales_settings` / `purchase_settings` rows (AR, revenue, output VAT,
  AP, expense, input VAT, RC output/input). The engine resolves accounts
  through those settings, so statutory tax codes remain tenant-shared while
  account wiring stays tenant-specific.
- `type` stays as the legacy snapshot string used by historical rows and the
  e-invoice importers. New logic reads `treatment` and related flags.
- Journal lines freeze tax metadata at posting time (treatment, code,
  rate, taxable base, tax amount, deductible/non-deductible split, leg type,
  reporting classification, legal note), preserving old behavior when the
  tax master changes later.

## Official rules verified

- vero.fi Rates of VAT (checked 2026-09-03): general 25.5 % (from
  2024-09-01, previously 24 %), reduced 13.5 % (from 2026-01-01, previously
  14 %), reduced 10 % (newspapers/magazines), 0 % taxable sales (exports,
  intra-EU goods to VAT-liable buyers and other listed supplies).
- vero.fi VAT reverse charge in the construction sector (checked
  2026-09-03): invoice without VAT + reverse-charge mention + buyer VAT
  number (domestic: Business ID) + grounds (§ 8 c AVL / Art 199 of Directive
  2006/112/EC); buyer reports purchases and VAT (25.5 %) and deducts when
  entitled; seller reports sales.
- vero.fi Intra-Community trade (checked 2026-09-03): intra-EU goods supply
  exempt when goods move, buyer VAT-registered in another EU state and valid
  VAT numbers; invoice wording e.g. "VAT 0%, intra-Community supply"; buyer
  acquisition self-assessed with input deduction.
- vero.fi Value-added taxation of cross-border supply and acquisition of
  services (record 11/15/2021, valid until further notice): B2B services are
  generally supplied where the customer is established (§ 65 AVL); the
  seller does not charge Finnish VAT and the customer applies the reverse
  charge mechanism.
