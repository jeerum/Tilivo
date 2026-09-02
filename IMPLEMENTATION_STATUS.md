# Implementatsiooni staatus

## Current version

**v0.2 (Identity)** – v0.1 hardening lõpetatud.

## Completed

- v0.1 hardening:
  - automaatne DB backup systemd timer'iga (`deploy/systemd`), retention 14 päeva;
  - restore-test PASS (production backup -> ajutine test-DB -> integrity -> eemaldamine);
  - restart policy `unless-stopped` + healthcheckid DB/API/Web PASS;
  - secrets permissions PASS (`.env` 600, backup-kaust 700, logid ilma paroolideta);
  - ADR-0004 PostgreSQL versioonipoliitika;
  - health endpoint production vastus ilma version/env/time detailideta.
- v0.2 migratsioonid: users, email_verification_tokens, password_reset_tokens, sessions,
  totp_credentials, recovery_codes, two_factor_challenges, auth_attempts, audit_events,
  dev_email_outbox.
- v0.2 Identity API: register, e-mail verify/resend, login/logout, me, password forgot/reset/change,
  TOTP setup/confirm/disable, recovery codes (genereerimine + ühekordne kasutus),
  sessioonid (list, revoke, revoke-others), remember me 30 päeva, CSRF double-submit,
  rate limiting + piiratud progressiivne cooldown, audit events, auth Error ID-d.
- v0.2 frontend auth UI (ET/EN): register, verify, login (sh 2FA challenge), forgot/reset,
  2FA seadistus + QR, recovery codes, sessioonid, password change, logout.
- CI: lint, typecheck, unit tests, build + isoleeritud PostgreSQL integration job.

## In progress

- Mitte ühtegi – v0.2 on lõpetatud.

## Not started

- v0.3 Multi-tenant / RLS
- v0.4 Audit/trace/dokumendid/inbox/outbox edasiarendus
- Accounting core (v0.5+) ja kõik hilisemad moodulid
- Avalik DNS/nginx kasutuselevõtt
- Production SMTP driver

## Known issues

- Avalik kasutus puudub teadlikult (ootab security review'd + kasutaja DNS-otsust).
- Production e-mail on `noop`, kuni SMTP credentials on olemas; seetõttu ei saa prod-kasutaja enne seda
  e-maili kinnitust lõpetada.
- 2FA võtmerotatsioon on arhitektuuris ette nähtud, aga CLI/teenus veel puudub.

## Tests

Käivitatud ja tulemused:

```text
Lokaalne: npm run test:ci
  lint PASS, typecheck PASS
  API unit-tests 23 PASS (integration skipped ilma TEST_DATABASE_URL)
  Web unit-tests 3 PASS
  build PASS

Serveris (test-DB): docker compose --profile test run --rm --build accounting-test
  36/36 PASS (unit + DB integration + identity security flows)

Migratsioon: fresh test-DB up PASS; down+up PASS (rollback testitud test-DB-s)
Backup: systemctl start mrjkp-accounting-backup.service PASS
Restore-test: PASS (11 tabelit + pgcrypto taastatud ajutisse DB-sse)
```

## Deployment status

- Deploy v0.2: `/opt/mrjkp-accounting`, containerid `mrjkp-accounting-*`, ainult `127.0.0.1:3100/3101`.
- Migratsioon `20260902120000_identity` rakendatud production DB-s; enne migratsiooni backup + restore-test.
- Healthcheck PASS; web PASS; auth negative smoke PASS (`AUTH-005`, `AUTH-002`, `AUTH-001`).
- Olemasolevad teenused pärast deploy'd kontrollitud – muutumatud.

## Next step

v0.3 Multi-tenant / RLS – ei alustata automaatselt ilma eraldi ülesandeta.
