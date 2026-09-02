# Credit notes (v0.6)

v0.6 toetab **täiskrediiti**. Osaline krediit on teadlik TODO, sest see nõuab
avatud saldode arvestust; täiskrediit on puhas ja ei tekita osalist staatust.

## Voog

```text
originaal ISSUED
  -> luuakse uus DRAFT krediitarve sama kliendi/valuutaga
  -> krediitarve ISSUE (oma number, oma kanne SALES_CREDIT_NOTE)
  -> sales_invoice_credit_links insert (kontrollib samasust)
  -> originaal CREDITED + credited_by_invoice_id
```

## Raamatupidamine

Kreeditarve kanne peegeldab originaali:

```text
D tulu / D käibemaks
C AR
```

Koos originaaliga on netoefekt pearaamatus 0 ja trial balance jääb tasakaalu.

## RLS/concurrency

- Originaali rida lukustatakse esimesena; 20 paralleelset täiskrediiti annavad
  täpselt ühe õnnestumise.
- Kreeditlink on insert-only ka otse SQL-i eest.
