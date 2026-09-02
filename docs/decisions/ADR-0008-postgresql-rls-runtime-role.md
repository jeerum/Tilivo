# ADR-0008 – PostgreSQL RLS runtime roll

Kuupäev: 2026-09-02

## Probleem

Tabeli omanik võib RLS-i bypassida (välja arvatud FORCE RLS-i puhul) ning superuser bypassib alati.
Et Tenant A ei saaks kunagi Tenant B andmeid, peab rakenduse DB roll olema piiratud.

## Otsus

- **`tilivo_app`** (containeri POSTGRES_USER) on migratsiooni/backup roll: superuser ainult
  isoleeritud containeri piires; hoiab tabelite ownership'i.
- **`tilivo_runtime`** on rakenduse runtime roll:
  - LOGIN, parool keskkonnast;
  - NOSUPERUSER, NOBYPASSRLS;
  - ei ole tabelite omanik;
  - saab ainult vajalikud DML-õigused (SELECT/INSERT/UPDATE/DELETE) tabelitele, mida RLS filtreerib.
- Tenant-owned tabelid: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
- RLS context: `SET LOCAL app.tenant_id` transaction-scoped.
- Membership/permission kontrollid tehakse SECURITY DEFINER funktsioonidega (owner = `tilivo_app`),
  mis võtavad vastu ainult sessionist tuleva `user_id` ja requesti `tenant_id`.

## Tagajärjed

- App roll ei saa RLS-i bypassida ega skeemi muuta.
- Migratsioonid/backup käivad `tilivo_app`-ga; `tilivo_runtime` ei kasuta kunagi migratsiooni URL-i.

