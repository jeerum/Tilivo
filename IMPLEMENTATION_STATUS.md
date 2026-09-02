# Implementatsiooni staatus

## Current version

**v0.3 (Multi-Tenant + PostgreSQL RLS)**

Security review seis: **v0.2 security review tehtud – CRITICAL/HIGH 0 open** (vt
`docs/SECURITY_REVIEW_V0_2.md`).

## Completed

- v0.1 hardening: backup systemd timer'iga, restore-test, health endpoint, ADR-0004.
- v0.2 Identity: users, e-mail verification, sessions, paroolid, TOTP 2FA, recovery codes,
  rate limiting, audit, CSRF.
- Rename MRJKP -> Tilivo:
  - branding (UI/HTML/README/docs): Tilivo;
  - package nimed: `tilivo`, `@tilivo/api`, `@tilivo/web`;
  - cookie nimed: `tilivo_session`, `tilivo_csrf`;
  - compose projekt/containerid: `tilivo`, `tilivo-db/api/web`;
  - serveri kaust: `/opt/tilivo`;
  - DB: `tilivo_accounting`, kasutaja `tilivo_app`;
  - backup systemd: `tilivo-backup.service/timer`;
  - füüsiline volume legacy nimega säilitatud (andmete turvalisus).
- Security review parandused: token/challenge race, TOTP replay, IDOR session revoke, timing enumeration,
  dev e-mail guard, Cache-Control, trust boundary, 2FA cooldown.
- v0.3: tenants/companies/memberships/roles/permissions, runtime DB roll + FORCE RLS,
  tenant transaction helper, permission service, tenant API ja frontend onboarding/switcher.

## In progress

- Mitte ühtegi.

## Not started

- v0.4 Audit & compliance edasiarendus
- Accounting core (v0.5+)
- Production SMTP driver

## Known issues

- Volume füüsiline nimi on legacy (`mrjkp-accounting-db-data`) – teadlik otsus, et andmeid mitte
  kopeerida ega riskida; dokumenteeritud.
- `/opt/mrjkp-accounting` (pre-rename koopia) jääb alles kuni eraldi kokkuleppeni.

## Tests

```text
npm run test:ci PASS (lint, typecheck, API unit, web unit, build)
Serveris test-DB: 52/52 PASS (sh v0.2 auth + v0.3 tenant/RLS/IDOR/pool tests)
Migratsioon up/down PASS
Backup PASS, restore PASS
```

## Deployment status

- `/opt/tilivo`, containerid `tilivo-*`, pordid 127.0.0.1:3100/3101.
- Health PASS, web PASS, auth smoke PASS.
- Avalik: **https://tilivo.mrjaak.com** (Let's Encrypt + isoleeritud nginx-vhost).
- v0.3 production: RLS enabled + FORCE, runtime roll `tilivo_runtime` (no superuser/bypassrls),
  migratsioonid rakendatud, backup/restore PASS.
- Vanad serveriteenused kontrollitud – muutumatud.

## Next step

v0.4 – ei alustata automaatselt.
