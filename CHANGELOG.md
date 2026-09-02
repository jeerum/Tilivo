# Changelog

## [0.2.0] - 2026-09-02

### Added

- v0.1 hardening: automaatne DB backup (systemd timer), restore-test, health endpointi kärpimine
  production'is, ADR-0004 PostgreSQL versioonipoliitika.
- v0.2 Identity: users, register, e-mail verification, login/logout, password reset/change,
  TOTP 2FA, recovery codes, sessioonid (remember me 30 päeva), CSRF double-submit, rate limiting,
  audit events, auth Error ID-d.
- Frontend auth UI (ET/EN) ja CI integration-DB.

### Deploy

- v0.2 deploy `/opt/mrjkp-accounting`; migratsioon `20260902120000_identity` rakendatud; backup enne
  migratsiooni tehtud ja restore-testitud.

## [0.1.0] – 2026-09-02

### Added

- v0.1 infrastruktuur: repo struktuur, backend/frontend skeletonid.
- `GET /api/v1/health` koos PostgreSQL kontrolliga.
- Migratsioonisüsteem (node-pg-migrate) ja esimene migratsioon `pgcrypto`.
- Struktureeritud logi, Trace ID ja Error ID.
- Config-valideerimine (Zod), lint, typecheck, unit-testid, prod-build.
- Isoleeritud Docker Compose deploy alus (projekt `mrjkp`).
- Dokumentatsioon ja ADR-id.

### Deploy

- Esimene isoleeritud v0.1 deploy VPS-ile (`/opt/mrjkp-accounting`), pordid 3100/3101 localhostis.
