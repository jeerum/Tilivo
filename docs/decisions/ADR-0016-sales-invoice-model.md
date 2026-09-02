# ADR-0016: Sales invoice model

Date: 2026-09-02
Status: accepted

## Context

V0.5 accounting core on valmis; vaja on esimest arveldusmoodulit, mis toodab
korrektseid pearaamatukandeid.

## Decision

- `business_parties` on ühine juriidiliste isikute tabel, kus
  `is_customer` / `is_supplier` on capability-d; v0.7 tarnija ei loo
  duplikaate.
- Arve on eraldi dokument (`sales_invoices` + read), mitte ainult kanne.
- Issued arve külmutatakse andmebaasi triggeritega; parandus on kreeditarve.
- Kõik tenant-omased viited on komposiit-FK-d `(tenant_id, id)`.
- Summad: NUMERIC; arvutus sentide täpsusega `decimal.js`
  (round-half-up, line-level).

## Consequences

- RLS + komposiit-FK + triggerid annavad kaitse ka otse SQL-i eest.
- Draft- ja issue-voog on eristatud; number tekib alles ISSUE ajal.
