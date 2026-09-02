# Changelog

## [0.4.0-partial] - 2026-09-02

- Desktop-first AppShell (sidebar + topbar, wide workspace).
- Audit: hash-chain, append-only, runtime UPDATE/DELETE denied.
- Documents/document_versions + local object storage + RLS; upload/confirm/download API.
- Retention policies/holds foundation.
- Integration inbox/outbox + `tilivo-worker` container.

## [0.4.0 gate closure] - 2026-09-02

- Object storage backup/restore + SHA-256 verification PASS.
- Production document/audit/cross-tenant smoke PASS.
- Playwright desktop/tablet/mobile + tenant switch PASS.
- `V0.4 PLATFORM + DESKTOP UI GATE: PASS`.

## [0.3.0] - 2026-09-02

- Multi-tenant domain: tenants, companies, memberships, roles, permissions.
- PostgreSQL RLS: runtime roll `tilivo_runtime` (NOSUPERUSER/NOBYPASSRLS), FORCE RLS,
  transaction-scoped tenant context, security definer funktsioonid.
- Tenant API ja frontend (onboarding + switcher + company/member/role vaade).
- Viimase Owner'i kaitse, membership/permission kontroll, audit sündmused.

## [Avalik kasutus 2026-09-02]

- `https://tilivo.mrjaak.com` on avalikult kasutusel (Let's Encrypt + isoleeritud nginx-vhost).
- `APP_BASE_URL` uuendatud.

## [Security review 2026-09-02] - v0.2

- Harden: verification/reset/challenge one-time atomicity.
- TOTP replay protection (`last_used_counter`).
- IDOR session revoke -> 404; timing enumeration mitigatsioon.
- `Cache-Control: no-store` auth vastustel; explicit trust proxy CIDR.
- Config guard: dev email/outbox keelatud production'is.
- Docs: `docs/SECURITY_REVIEW_V0_2.md`, ADR-0006.

## [Rename 2026-09-02] - MRJKP -> Tilivo

- Toote branding, HTML/UI, README/docs: Tilivo.
- Package nimed: `tilivo`, `@tilivo/api`, `@tilivo/web`.
- Cookie nimed: `tilivo_session`, `tilivo_csrf`.
- Docker Compose projekt ja containerid: `tilivo`, `tilivo-db/api/web`.
- Serveri kaust: `/opt/tilivo`; systemd: `tilivo-backup.*`.
- DB: `tilivo_accounting`, kasutaja `tilivo_app` (sama data, sama TOTP key).
- Füüsiline volume legacy nimega säilitatud; vanad MRJKP backupid jäid ajalooks.

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
