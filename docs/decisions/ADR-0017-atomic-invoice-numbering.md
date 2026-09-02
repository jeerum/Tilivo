# ADR-0017: Atomic invoice numbering at issue

Date: 2026-09-02
Status: accepted

## Context

Drafts võivad tekkida ilma numbrita; numbri jaotus peab olema concurrency-safe
ja mitte kunagi korduma.

## Decision

- Number eraldatakse ainsas `issue` transactionis:
  `UPDATE invoice_number_series SET next_number = next_number + 1 RETURNING`.
- Seeriarida lukustatakse sama transactioni alguses, enne kande postitust.
- Formaat: `{prefix}{year}-{6-kohta}`; aasta seeria fiskaalaastast või
  arve kuupäevast.
- Gaps on lubatud ja dokumenteeritud; gapless-süsteemi ei ehitata.

## Consequences

100 paralleelset issue -> 100 unikaalset numbrit. Idempotentsus tuleb
staatuse kontrollist + rea lukust: sama draft'i 20 paralleelset issue'i annab
ühe õnnestumise ja ühe numbri.
