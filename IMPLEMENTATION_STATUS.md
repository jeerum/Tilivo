# Implementatsiooni staatus

## Current version

**v0.2 (Identity) + kontrollitud rename MRJKP -> Tilivo**

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

## In progress

- Mitte ühtegi.

## Not started

- v0.3 Multi-tenant / RLS
- Accounting core (v0.5+)
- Avalik DNS/nginx kasutuselevõtt
- Production SMTP driver

## Known issues

- Volume füüsiline nimi on legacy (`mrjkp-accounting-db-data`) – teadlik otsus, et andmeid mitte
  kopeerida ega riskida; dokumenteeritud.
- `/opt/mrjkp-accounting` (pre-rename koopia) jääb alles kuni eraldi kokkuleppeni.

## Tests

```text
npm run test:ci PASS (lint, typecheck, API unit, web unit, build)
Serveris test-DB: 36/36 PASS
Migratsioon up/down PASS
Backup PASS, restore PASS
```

## Deployment status

- `/opt/tilivo`, containerid `tilivo-*`, pordid 127.0.0.1:3100/3101.
- Health PASS, web PASS, auth smoke PASS.
- Vanad serveriteenused kontrollitud – muutumatud.

## Next step

v0.3 – ei alustata automaatselt.
