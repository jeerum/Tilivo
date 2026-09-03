# ADR-0023: OCR/extraction trust model

Date: 2026-09-03
Status: accepted

## Context

Ekstraheerimine ei tohi olla autoriteet enne kasutajakinnitust.

## Decision

- Extraction read on append-only, allikaga (STRUCTURED_XML/OCR/MANUAL) ja
  konfidentsiga.
- OCR provider on Noop v0.7-s; manuaalne review töötab ilma OCR-ita.
- Ekstraheeritud tekst ei saa olla SQL/HTML/path autoriteet.

## Consequences

- Parser/OCR vigade korral jääb arve NEEDS_REVIEW.
