# Tilivo Multi-Tenancy (v0.3)

## Mudel

- `tenants` – turvapiir ja andmete omanik.
- `companies` – juriidiline üksus, kuulub tenant'ile (`tenant_id NOT NULL`).
- `memberships` – kasutaja kuuluvus tenant'i (`unique (tenant_id, user_id)`).
- `roles` / `permissions` / `role_permissions` / `membership_roles` – roll = permission'ite kogum.
- Tenant loomisel luuakse ühes transaktsioonis: tenant, company, membership ja Owner-roll.

## API

```text
POST /api/v1/tenants                     # tenant + company + Owner bootstrap
GET  /api/v1/tenants                     # minu tenant'id
GET  /api/v1/companies/current           # X-Tilivo-Tenant-Id
PATCH /api/v1/companies/current
GET  /api/v1/members
POST /api/v1/members                     # olemasoleva kasutaja lisamine (Employee vaikimisi)
PATCH/DELETE /api/v1/members/:id
POST/DELETE /api/v1/members/:id/roles[/:roleId]
GET  /api/v1/roles
```

## Reeglid

- Iga tenant-scoped request: session auth -> membership check -> permission check -> RLS transaction.
- Viimast Owner'it ei saa eemaldada/downgrade'ida (`MEMBER-002`).
- Suspended/removed membership ja suspended tenant lükatakse tagasi.
- Tenant context on request-scoped (`X-Tilivo-Tenant-Id`), mitte globaalne.

