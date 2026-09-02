# Invoice lifecycle

```text
DRAFT ──issue──> ISSUED ──full credit──> CREDITED
   │
   └──cancel──> CANCELLED_DRAFT
```

- DRAFT: muudetav, number puudub, kandeid pole.
- ISSUED: number, makseviide, kliendi snapshot, read ja summad on külmutatud.
- CREDITED: originaal viitab täiskrediidile (`credited_by_invoice_id`).
- CANCELLED_DRAFT: lõppseis; seda ei saa esitada ega muuta.

## Issue transaction (üks kontrollitud voog)

1. lukusta arve `FOR UPDATE`, kontrolli `DRAFT` ja tenandikuuluvust;
2. kontrolli klient aktiivne, read olemas, kuupäevad ja valuuta korrektsed;
3. arvuta read ja summad serveris uuesti (Decimal, sentide ümardamine);
4. eralda seerianumber atomically `UPDATE ... RETURNING next_number - 1`;
5. genereeri makseviide ja salvesta kliendi snapshot;
6. loo + postita pearaamatukanne läbi v0.5 postitusmootori;
7. märgi arve `ISSUED` koos kande lingiga;
8. lisa `SALES_INVOICE_ISSUED` ja `SALES_INVOICE_PDF_REQUESTED` outbox
   sündmused samas transactionis;
9. commit.

Kui kanne ebaõnnestub, tagastatakse kogu transaction; `ISSUED` ilma kandeta
või kanne ilma arveta ei ole võimalik.

## Immuutsus

Andmebaasi triggerid keelavad issued arve, selle ridade ja numbri
UPDATE/DELETE ka otse runtime rolli SQL-ga. Kreeditlink on insert-only;
valmis PDF on külmutatud.

## PDF olekud

```text
GENERATING -> READY
GENERATING -> FAILED -> (retry) -> GENERATING
```

PDF-i töötleb `tilivo-worker`; töötlemise ebaõnnestumine ei puuduta arve
finantspoolt.
