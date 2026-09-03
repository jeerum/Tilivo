# E-invoice adapters

Kõik adapterid mapivad oma XML-i ühte canonical
`CanonicalPurchaseInvoice` mudelisse; domain-loogika ei sõltu skeemist.

| Adapter | Katvus |
| --- | --- |
| Finvoice 3.x | dokumenteeritud minimumprofiil: seller, number, kuupäevad, valuuta, read, VAT, kokku |
| PEPPOL BIS 3.0 | minimum ingestion: supplier, ID/dates/currency, lines, tax, totals, payment reference |
| TEAPPSXML | minimumprofiil fixture-importidele; operaatori variante säilitatakse source metadata kaudu |

## XML security

- DTD/DOCTYPE/ENTITY keelatud enne parsimist.
- Suurusepiir 1 MB.
- Parseri ühiku `secureXml.ts` testid: XXE, entity expansion, malformed,
  oversized, missing fields.

Real operator API ühendus puudub teadlikult; v0.7 gate põhineb fixture/import
voogudel. Ametlikku PEPPOL validation stacki ei väideta.
