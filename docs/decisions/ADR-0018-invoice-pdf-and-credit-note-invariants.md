# ADR-0018: PDF and credit note invariants

Date: 2026-09-02
Status: accepted

## Context

Arve PDF peab olema auditeeritav dokument, kreedit peab parandama ilma ajalugu
ümber kirjutamata.

## Decision

- PDF renderdatakse serveris deterministlikult ja salvestatakse versioneeritud
  dokumentide mudelisse; issued PDF on immuutne.
- PDF-i töötleb worker outbox-sündmuse kaudu, mitte HTTP-päringus.
- Full credit on ainus v0.6 parandusvoog; kreeditarve on iseseisev arve.
- Kreeditlink on insert-only ning valideerib kliendi, valuuta ja summa.

## Consequences

- UI näitab PDF olekut GENERATING/READY/FAILED; retry on õigustepõhine.
- Kreeditkonkurents on ohutu (üks õnnestumine 20 paralleelse päringu puhul).
