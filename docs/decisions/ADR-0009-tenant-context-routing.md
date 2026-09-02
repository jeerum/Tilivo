# ADR-0009 – Tenant context ja route mudel

Kuupäev: 2026-09-02

## Otsus

- Tenant context edastatakse päisega **`X-Tilivo-Tenant-Id`** (request-scoped, mitte globaalne).
- Server lahendab igal tenant-scoped requestil:

```text
session auth -> requested tenant id -> ACTIVE membership kontroll -> tenant status ->
permission kontroll -> RLS transaction
```

- Päis on ainult soov: autoriteetne kontroll on membership + permission + RLS.
- `tenants` list/loomine on tenant-ülesed endpointid ilma tenant päiseta.
- Audit: `requested_tenant_id` ja `authorized_tenant_id` logitakse eraldi.

## Tagajärjed

- Suvalist tenant ID-d ei saa otse RLS context'i panna ilma membership-kontrollita.
- Frontend vahetab tenant'i ainult päise muutmisega; state tuleb switchil tühjendada.

