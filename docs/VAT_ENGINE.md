# Tilivo VAT / ALV engine (v0.9)

## Purpose

VAT is not a percentage field on an invoice. A v0.9 tax code carries a
semantic treatment, direction, flags (reverse charge / intra-EU / export /
import), effective-date history, deductibility and legal-note templates. The
`vatEngineService` turns treatment + direction + date into deterministic
amounts, journal legs and reporting classifications; sales and purchase
services consume those results and post only through the Accounting Core.

## Tax-code model

`tax_codes` (tenant-owned, existing table extended):

- `code`, `name`, `country_code`, `rate` (NUMERIC(10,4))
- `type` — retained as the legacy snapshot string used by old rows and
  e-invoice importers
- `treatment` — semantic category (`STANDARD`, `REDUCED`, `ZERO_RATED`,
  `EXEMPT`, `EU_GOODS_SUPPLY`, `EU_GOODS_ACQUISITION`,
  `EU_SERVICE_SUPPLY`, `EU_SERVICE_ACQUISITION`, `EXPORT`, `IMPORT`,
  `REVERSE_CHARGE`, `CONSTRUCTION_REVERSE_CHARGE`, `OWN_USE`)
- `direction` — `SALES`, `PURCHASE` or `BOTH`
- `effective_from` / `effective_to` — rate and rule history rows
- `reverse_charge`, `intra_eu`, `is_export`, `is_import`
- `deductible_percent` — default input VAT deductibility (0-100)
- `legal_notes` — localised invoice note templates (fi/en/et)
- `is_system` — statutory rows are protected from tax-definition edits
- legacy `reporting_mapping` remains a snapshot hint for historical data

Account-level wiring stays in tenant settings (`sales_settings` /
`purchase_settings`): AR, revenue, output VAT, AP, expense, input VAT and
reverse-charge input/output accounts. Statutory definitions are tenant-local
rows seeded idempotently; account wiring is tenant-specific by design.

## Engine semantics

`calculateVat({ direction, treatment, rate, netAmount, deductiblePercent,
legalNotes, language })` returns:

- taxable base, invoice VAT, self-assessed VAT, reportable VAT
- deductible and non-deductible VAT (purchases only)
- gross, expense and payable amounts
- VAT legs (`OUTPUT_VAT`, `INPUT_VAT`, `RC_OUTPUT_VAT`, `RC_INPUT_VAT`)
- reporting classification and legal note

Rules:

- domestic standard/reduced sales → AR / Revenue / Output VAT
- domestic standard/reduced purchases → Expense / Input VAT / AP, with
  deductibility: non-deductible VAT is capitalised into the expense line
- EU goods/services acquisition, general reverse charge, construction RC
  purchases and imports → self-assessed `RC_OUTPUT_VAT` +
  `RC_INPUT_VAT`; the supplier invoice total stays net
- EU goods/services supplies, exports, exempt and zero-rated sales →
  no VAT legs, distinct reporting classifications
- construction RC sale → no ordinary output VAT; invoice legal note refers
  to § 8 c AVL / Art. 199 of Directive 2006/112/EC and the buyer Business ID
- credit notes and corrections invert amounts through the existing
  Accounting Core correction architecture

## Effective dates

Seeded Finnish history (same stable code, multiple dated rows):

| Code | 2013-01-01 | 2024-09-01 | 2026-01-01 |
| --- | --- | --- | --- |
| `FI_SALES_STD` / `FI_PURCHASE_STD` | 24 % (to 2024-08-31) | 25.5 % | 25.5 % |
| `FI_SALES_REDUCED_MAIN` / `FI_PURCHASE_REDUCED_MAIN` | 14 % (to 2025-12-31) | 14 % | 13.5 % |
| `FI_SALES_REDUCED_10` / `FI_PURCHASE_REDUCED_10` | 10 % | 10 % | 10 % |

EU/import/RC codes are dated from 2024-09-01 (current statutory landscape).
Posting resolves the tax code version valid for the transaction date and
freezes rate/treatment/classification on the journal line, so later master
changes never rewrite history.

## Journal tax metadata

`journal_lines` now freezes:

- `tax_code_snapshot`, `tax_treatment_snapshot`, `applied_tax_rate`
- `taxable_base_snapshot`, `tax_amount_snapshot`
- `tax_deductible_snapshot`, `tax_nondeductible_snapshot`
- `tax_leg_type` (`REVENUE`, `EXPENSE`, `OUTPUT_VAT`, `INPUT_VAT`,
  `RC_OUTPUT_VAT`, `RC_INPUT_VAT`)
- `tax_reporting_classification`, `tax_legal_note`

Posted and reversed lines are immutable; reversals and purchase corrections
mirror the metadata.

## VAT Summary

`GET /api/v1/vat-summary?from=&to=` (`tax.report.read`) reads only POSTED
journals in the range and returns per-classification sales, purchases,
output VAT, deductible input VAT and net VAT, plus totals. UI:
Accounting → VAT summary tab (ALV kokkuvõte).

## Reporting classifications

`DOMESTIC_OUTPUT_VAT`, `DOMESTIC_INPUT_VAT`, `ZERO_RATED`, `EXEMPT`,
`EU_GOODS_SUPPLY`, `EU_GOODS_ACQUISITION`, `EU_SERVICES_SUPPLY`,
`EU_SERVICES_ACQUISITION`, `EXPORT`, `IMPORT`, `REVERSE_CHARGE`,
`CONSTRUCTION_RC`, `OWN_USE`.

## Legal wording

Legal notes are data on the seeded tax codes, filled at render time with the
buyer Business ID / VAT number. Wording for construction RC (§ 8 c AVL /
Art. 199), EU supplies and exports is shown on invoices and in the PDF.

## Official sources

Verified 2026-09-03:

- vero.fi Rates of VAT —
  https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/rates-of-vat/
  (general 25.5 %; reduced 13.5 % from 2026-01-01, previously 14 %; reduced
  10 %; 0 % taxable sales incl. exports and intra-EU supplies)
- vero.fi VAT reverse charge in the construction sector —
  https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/vat-in-different-lines-of-business/vat-reverse-charge-in-the-construction-sector/
- vero.fi Intra-Community trade —
  https://www.vero.fi/en/businesses-and-corporations/taxes-and-charges/vat/international-commerce/intra-community-trade
- vero.fi Value-added taxation of cross-border supply and acquisition of
  services (VH/4150/00.01.00/2021) —
  https://www.vero.fi/en/detailed-guidance/guidance/48679/

## Tests

```text
Unit:            apps/api/tests/vatEngine.test.ts (rounding, treatments,
                 deductibility, classifications, legal notes)
Integration:     apps/api/tests/vat_v09.integration.test.ts (seed, sales,
                 purchases, RC/EU/export, deductibility, history, credit,
                 summary, permissions, period lock, idempotency)
Web unit:        apps/web/src/lib/tax.test.ts
Browser E2E:     apps/web/e2e/vat_v09.spec.ts (desktop/tablet/mobile)
```

## Known limitations

- VIES live VAT-number verification is not wired; the model stores VAT
  numbers and registry data and leaves validation to a later feature.
- Import VAT is modelled as a self-assessed acquisition with output/input
  legs; customs declaration settlement workflow is not built.
- Reduced-rate EU acquisition codes are not pre-seeded; create a custom tax
  code with the desired treatment/rate if needed.
- e-invoice importers map legacy rate/type to the closest seeded domestic or
  reverse-charge code; ambiguous EU classification requires manual review.
