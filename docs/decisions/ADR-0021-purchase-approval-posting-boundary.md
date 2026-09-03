# ADR-0021: Purchase approval/posting boundary

Date: 2026-09-03
Status: accepted

## Context

Ärikinnitus ja raamatupidamispostitus on erinevad õigustasandid.

## Decision

- APPROVED = ärikinnitus; POSTED = kanne õnnestus.
- `require_separate_approver` keelab looja enesekinnituse.
- `auto_post_on_approval` on tenant-seadistus; postitus kasutab sama
  kontrollitud engine'it ja ebaõnnestumisel ei jää vale POSTED seis.

## Consequences

- Four-eyes ja auto-post on konfigureeritavad ilma rollisüsteemi muutmata.
