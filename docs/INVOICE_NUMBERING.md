# Invoice numbering

Number eraldatakse **ainult ISSUE ajal** seeriast
`invoice_number_series.next_number`.

## Formaat

```text
{series.prefix}{year}-{6-kohaline number}
```

Näited:

```text
2026-000001          (vaikeseeria, prefix tühi)
INV-2026-000001      (prefix "INV-")
```

Aasta tuleb seeria `fiscal_year_id` algusest või arve kuupäevast.
Padding on fikseeritud 6 kohta v0.6-s.

## Concurrency

`next_number` suurendatakse `UPDATE ... SET next_number = next_number + 1`
abil; seeriarida lukustatakse sama transactioni sees. 100 paralleelset issue
testi annavad 100 unikaalset numbrit ja 0 duplikaati.

Gaps on teadlik otsus: rollback/error järel võib number vahele jääda.
Gapless-loogikat pole, sest see nõuaks lisahoide ja pole seaduslik nõue.

## Seeriad

- Igale olemasolevale tenandile lisatakse migratsiooniga vaikeseeria
  (`Default`, prefix tühi).
- Uued tenandid saavad seeria esimese arve loomisel automaatselt, kui seda
  veel pole.
- API: `GET/POST /api/v1/sales/series`, `PATCH .../series/:id`.
- Seeria numbrit (`next_number`) ei saa API kaudu muuta.

Vt ka ADR-0017.
