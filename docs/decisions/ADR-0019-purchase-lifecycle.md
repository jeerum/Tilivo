# ADR-0019: Purchase lifecycle

Date: 2026-09-03
Status: accepted

## Context

Ostuarvete töövoog peab hoidma sisend-, ülevaatus-, kinnitus- ja
raamatupidamisosa eraldi.

## Decision

- INGESTED/DRAFT -> NEEDS_REVIEW -> READY_FOR_APPROVAL -> APPROVED -> POSTED;
  REJECTED, CANCELLED_DRAFT ja CORRECTED on lõppseisundid.
- APPROVED külmutab finantsväljad; POSTED lisab kande.
- Posted arve parandatakse ainult reversal-kande kaudu.

## Consequences

- Triggerid keelavad tagasipöörde ja vaikse edit'i.
