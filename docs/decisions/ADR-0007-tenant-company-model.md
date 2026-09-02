# ADR-0007 – Tenant/Company mudel

Kuupäev: 2026-09-02

## Otsus

- **Tenant** on turvapiir ja andmete omanik (`tenants`).
- **Company** on juriidiline/äriline üksus (`companies`), mis kuulub tenant'ile
  (`tenant_id NOT NULL`).
- Esimeses versioonis loob iga uus tenant automaatselt ühe company; andmemudel ei välista
  hiljem mitut company't ühe tenant'i all.
- `tenant_id` ja `company_id` ei segata: kõik tenant-owned tabelid kasutavad `tenant_id`.

## Tagajärjed

- RLS-poliitikad ja indeksid baseeruvad `tenant_id`-l.
- Company-objektidel on `tenant_id` immutable tavakasutuses.

