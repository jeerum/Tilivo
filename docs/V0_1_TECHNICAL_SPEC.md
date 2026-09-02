# V0.1 tehniline spetsifikatsioon

Kuupäev: 2026-09-02 · Staatus: lukustatud

## Ulatus

v0.1 on infrastruktuurivundament, mitte ärimoodulid. Valmis on:

- `GET /api/v1/health` (DB-ühenduse kontroll, Trace ID, struktureeritud logi)
- PostgreSQL + migratsioonid
- React frontend skeleton (avaneb, kuvab health-seisundit)
- Lint / typecheck / unit-testid / build / CI skeleton
- Isoleeritud Docker Compose deploy

Ei kuulu v0.1-sse: identity, accounting, arved, pank, payroll, AI, SaaS billing.

## Lukustatud valikud

| Valdkond | Valik | Põhjendus |
| --- | --- | --- |
| Keeled | TypeScript nii API kui web | ühtne stack, tugev tüübitus |
| Backend | Node 22 LTS + Fastify 5 | kiire, JSON Schema, pino logi |
| Frontend | React 19 + Vite 6 | stabiilne, kerge build |
| DB | PostgreSQL 17 (Docker) | pikaajaline tugi |
| DB-pöördus | `pg` + node-pg-migrate | täpne SQL-kontroll, migratsioonid source control'is |
| Konfig | Zod + environment | vale env peatab startup'i varakult |
| Deploy | Docker Compose projekt `mrjkp` | serveri olemasolev muster, täielik isoleerimine |
| Logi | pino JSON, `trace_id`, redaktsioon | jälgitavus ilma saladuste lekketa |

## Nimekonventsioonid (server)

- Project: `mrjkp`
- Service/containerid: `accounting-api`, `accounting-web`, `accounting-db`
- Network: `mrjkp-accounting`
- Volume: `mrjkp-accounting-db-data`
- DB/kasutaja: `mrjkp_accounting` / `mrjkp_accounting_app`
- Host-pordid: `127.0.0.1:3100` (API), `127.0.0.1:3101` (web)

## API leping v0.1

```text
GET /                -> service info
GET /api/v1          -> API v1 info
GET /api/v1/health   -> 200 ok / 503 degraded + checks.database
GET /docs            -> OpenAPI UI (ainult EXPOSE_DOCS=true)
```

Iga response sisaldab päist `x-trace-id`. Vea korral sisaldab body `error.code` (nt `DB-001`, `SYS-001`) ja
`error.trace_id`.

## Testikriteerium v0.1 läbimiseks

- `npm run lint` PASS
- `npm run typecheck` PASS
- unit-testid PASS
- integration-testid migreeritud puhta test-DB vastu PASS (serveris, profile `test`)
- prod-build PASS
- startup-test PASS
- serveri smoke-test: API health 200, web 200, web->API proxy 200
- olemasolevad teenused enne/pärast muutumatud

