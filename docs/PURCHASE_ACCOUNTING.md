# Purchase accounting

```text
D Expense/Asset (rida neto)
D Input VAT (tax, tavaliste VAT-ridade puhul)
C Accounts Payable (arve total)
```

- Kontod tulevad `purchase_settings` + line `expense_account_id` kaudu; magic
  ID-sid pole.
- REVERSE_CHARGE: rida säilitab tax type; kui reverse-accountid puuduvad,
  postitus keeldub (PUR-009). Olemasolul postitatakse sisend-/väljundkäibemaks
  sama summaga, neto kulu ja AP.
- Summad arvutatakse serveris Decimal/NUMERIC sentide täpsusega; source total
  erinevus blokeerib postituse.
- Journal: `source_type=PURCHASE_INVOICE`, `source_id=purchase_id`; korrektsioon
  kasutab `PURCHASE_CORRECTION` reversal-kannet.

Täispikk FI VAT return tuleb v0.10.
