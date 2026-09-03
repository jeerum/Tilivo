# Purchase lifecycle

```text
INGESTED ─parse/review─> NEEDS_REVIEW ─review─> READY_FOR_APPROVAL
DRAFT ─review─> READY_FOR_APPROVAL
READY_FOR_APPROVAL ─approve─> APPROVED ─post─> POSTED
NEEDS_REVIEW/READY_FOR_APPROVAL ─reject─> REJECTED
POSTED ─correct─> CORRECTED (reversal journal)
```

- INGESTED: e-arve/üleslaaditud dokument registreeritud.
- DRAFT: manuaalne sisestus.
- NEEDS_REVIEW: tarnija või väljad vajavad kinnitust.
- READY_FOR_APPROVAL: serveripoolne valideerimine tehtud.
- APPROVED: ärikinnitus lõppenud; finantsväljad külmutatud.
- POSTED: kanne postitatud läbi v0.5 mootori; kõik tähtis immutable.
- CORRECTED: kontrollitud reversal-kanne; net effect 0.

## Immuutsus

- POSTED/APPROVED/CORRECTED/REJECTED ridu ei saa otse SQL-ga muuta.
- Kinnitatud dokumentide versioonid on immutable.
- Revisjon toimub `/correct` kaudu, mitte vaikse editina.
