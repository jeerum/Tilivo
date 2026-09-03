# ADR-0020: E-invoice canonical model

Date: 2026-09-03
Status: accepted

## Context

Finvoice/PEPPOL/TEAPPSXML skeemid erinevad; domain ei tohi neist sõltuda.

## Decision

- Adapterid mapivad XML-i ühte `CanonicalPurchaseInvoice` objekti.
- XML parsimine on turvaline: DTD/ENTITY keelatud, 1 MB piir, tõrked
  EINV-* Error ID-dena.
- v0.7 katvus on dokumenteeritud minimumprofiil, mitte täiscompliance.

## Consequences

- Uue operaatori lisamine = uus adapter.
