# PostgreSQL RLS security (v0.3)

## Rollid

- `tilivo_app` – migratsiooni/backup roll, tabelite omanik (superuser ainult isoleeritud containeris).
- `tilivo_runtime` – rakenduse runtime roll: NOSUPERUSER, NOBYPASSRLS, ei ole tabelite omanik.

## Seadistus

- Tenant-owned tabelid: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
- Policy: `tenant_id = public.tilivo_tenant_id()` (SELECT/INSERT/UPDATE/DELETE).
- Tenant context: `SELECT set_config('app.tenant_id', $1, true)` transaction-scoped.
- Ilma context'ita päring tagastab 0 rida (fail-closed).

## Kontrollitud sissepääsud

Security definer funktsioonid (owner `tilivo_app`):

- `tilivo_resolve_membership(user_id, tenant_id)`
- `tilivo_list_my_tenants(user_id)`
- `tilivo_has_permission(user_id, tenant_id, permission)`

Nad võtavad kasutaja ID ainult sessioonist; requesti tenant ID läbib membership-kontrolli enne RLS
context'i seadmist.

