# Changelog

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

