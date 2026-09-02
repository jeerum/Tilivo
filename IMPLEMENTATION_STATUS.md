# Implementatsiooni staatus

## Current version

**v0.1** (infrastruktuurivundament)

## Completed

- Repo struktuur: `apps/api`, `apps/web`, `docs`, `deploy`, `compose.yaml`
- Backend Fastify + TypeScript skeleton, `/api/v1`
- `GET /api/v1/health` koos DB-kontrolliga (`SELECT 1`)
- PostgreSQL ühendus ja isoleeritud DB (Docker Compose)
- Migratsioonisüsteem node-pg-migrate + esimene migratsioon (`pgcrypto`)
- Config/environment valideerimine (Zod)
- Struktureeritud logid (pino), Trace ID (`x-trace-id`), Error ID baas
- OpenAPI `/docs` (lubatud `EXPOSE_DOCS=true` korral)
- Frontend React skeleton: lihtne hele UI, i18n ET/EN, health-state leht
- Testiraamistik: Vitest; unit-testid API ja web jaoks
- Lint (ESLint) + typecheck (TypeScript)
- Build: tsup backend, Vite frontend
- Dockerfile'id + isoleeritud Docker Compose (projekt `mrjkp`)
- CI skeleton: root `test:ci`; GitHub Actions `deploy/ci.yml` (vt all)
- Dokumentatsioon: README, ARCHITECTURE, DEPLOYMENT, IMPLEMENTATION_STATUS, CHANGELOG, ADR-id, BACKUP_STRATEGY
- v0.1 deploy Linux VPS-ile isoleeritult (port 3100/3101, localhost)

## In progress

- Mitte ühtegi – v0.1 tõötsükkel on lõpetatud pärast smoke-testi.

## Not started

- v0.2 Identity (users, register, e-mail verification, login, logout, password reset, TOTP 2FA,
  remember me 30 päeva, sessions, rate limiting, brute-force protection)
- v0.3 Multi-tenant / RLS
- v0.4 Audit + inbox/outbox jne
- Accounting core ja kõik hilisemad moodulid
- Avalik DNS/nginx-kaitseta avamine

## Known issues

- Avalik kasutus ei ole veel avatud (puudub kasutaja valitud alamdomeen/DNS).
- CI (GitHub Actions) on skeleton ja töötab pärast repo üleslaadimist esimest korda.
- Hetkel puudub püsiv backup ajastamine serveris; vt `docs/BACKUP_STRATEGY.md`.

## Tests

Viimane kohalik käivitamine (v0.1):

```text
apps/api:  lint PASS, typecheck PASS, unit tests 11 PASS (2 integration skipped ilma TEST_DATABASE_URL), build PASS
apps/web:  lint PASS, typecheck PASS, unit tests 3 PASS, build PASS
```

Integration-testid migreeritud test-DB vastu: jooksevad serveris `docker compose --profile test run --rm
accounting-test` (migration up + `npm test` koos `TEST_DATABASE_URL`-ga).

## Deployment status

- Deploy: tehtud `/opt/mrjkp-accounting`, containerid `mrjkp-accounting-*`, ainult `127.0.0.1:3100/3101`.
- Healthcheck: `GET /api/v1/health` PASS.
- Frontend: `GET http://127.0.0.1:3101/` PASS.
- Olemasolevad teenused enne ja pärast: kontrollitud (nginx, docker-containerid, pordid).

## Next step

v0.2 Identity esimene slice: users tabel + registreerimise ja e-maili kinnituse API/protsess, testidega.

