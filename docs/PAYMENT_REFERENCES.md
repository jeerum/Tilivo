# Payment references

Provider on eraldatud puhtast loogikafailist (`src/lib/paymentReferences.ts`);
arve nummerdamine ja viitenumbri genereerimine on lahti ühendatud.

## FI domestic (Soome viitenumber)

Kaalud 7-3-1 paremalt vasakule, kontrollnumber viib summa täiskümneni:

```text
1234567 -> 12345672
```

## RF creditor reference (ISO 11649)

`RFxx` + numbriline tuum. Kontroll arvutatakse tuumast + `RF00` vaste
(`271500`) moodul 97:

```text
539007547034 -> RF18 5390 0754 7034
```

## Arvel

Issue ajal kasutatakse arve numbri numbriosast tuletatud baasi. Tüüp tuleb
seadistusest (`FI_DOMESTIC` / `RF` / `NONE`).

Testid: standardvektorid, valideerimine, round-trip ja NONE-tüüp.
