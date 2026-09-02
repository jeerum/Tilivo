# ARHITEKTUUR – MRJKP Accounting

Selle dokumendi aluseks on `raamatupidamise_saas_ARCHITECTURE_v2.md` (source of truth toote ja arhitektuuri
jaoks). Käesolev dokument hoiab kokku praeguse v0.2 arhitektuuri ja ei kirjuta algset plaani üle.

## Mittekaubeldavad invariandid (alates v0.1)

1. **Tenant A ei saa kunagi Tenant B andmeid.**
2. **Postitatud finantskanne on immutable** – parandus tehakse reversal/correction kannetega.
3. **Iga postitatud kanne: SUM(debit) == SUM(credit).**
4. **Finantssündmus ja kanne tekivad ühe kontrollitud protsessina** (COMMIT koos).
5. **Välised sündmused on idempotentsed.**
6. **Kõik oluline on auditeeritav.**
7. **AI ei arvuta deterministlikke finantsreegleid.**
8. **Country rules on versioonitud.**

Need invariandid on hetkel arhitektuurikohustusena dokumenteeritud; jõustuvad koos vastavate moodulitega
(v0.3+, v0.5+), mitte v0.1 skeemis.

## Põhimudel v0.1

```text
Web frontend (React, auth UI)
      |
      v
Backend API (Fastify) – /api/v1, /api/v1/auth
      |
      +-- PostgreSQL (isoleeritud Docker)
```

- Modulaarne monoliit: backend on üks protsess, moodulid (identity, accounting, sales jne) lisatakse rangelt
  eraldatud piiridega hiljem.
- API versioon alates esimesest päevast: `/api/v1/...`.
- Keskkonnad DEV / STAGING / PROD on eraldatud `NODE_ENV` + eraldi `.env` + eraldi DB-ga.
- Raha: ainult `NUMERIC/DECIMAL` andmebaasis; JavaScript floating point ei kasutata kunagi rahaarvutuseks.
- Aeg: tehnilised timestamp'id UTC-s; business date eraldi (alates accounting moodulist).
- Seaded ja paroolid: ainult environment/secrets, `.env` on gitignore'is, repo sisaldab `.env.example`.

## Backend moodulid v0.2

- `config` – Zod-valideeritud environment
- `db` – pg pool
- `routes/health` – `GET /api/v1/health` (kontrollib `SELECT 1`)
- `routes/auth` – register, verify, login/logout, sessioonid, parool, TOTP 2FA, recovery codes
- `lib/errors` – Error ID baas (`SYS-001`, `DB-001`, `API-001`, `API-002`, `CFG-001`)
- `lib/security` – Argon2id, token-hash, TOTP, AES-256-GCM
- `services/*` – email provider, audit, auth/session/identity teenused
- Trace ID: `x-trace-id` päis; kui puudub, genereeritakse UUID; logides `trace_id`
- Struktureeritud logid pino JSON-formaadis; redaktsioon enne logi
- OpenAPI (dokid `/docs` ainult siis, kui `EXPOSE_DOCS=true`)

## Andmebaas

- PostgreSQL 17 isoleeritud container/volume.
- Migratsioonid node-pg-migrate abil, failid `apps/api/migrations/`.
- Esimene migratsioon lisab `pgcrypto`; teine loob identity tabelid (users, sessions, tokens, 2FA, audit).
- Rakenduse DB-kasutaja on projekti oma; olemasolevaid andmebaase ei puudutata.

## Frontend

- React 19 + Vite; hele, lihtne UI; i18n valmidus ET/EN läbi `src/i18n/translations.ts`.
- Auth lehed: register, verify, login, forgot/reset, 2FA seadistus, sessioonid, väljalogimine.
- `apps/web/nginx.conf` serveerib staatilist buildi ja proksib `/api` backendile.

## Deploy põhimõtted

- Isoleeritud Docker Compose projekt (`mrjkp`), oma network/volume/DB/kasutaja/pordid.
- Olemasolevaid serveriteenuseid ei peatata ega muudeta.
- Automaatne DB backup systemd timer'iga (`deploy/systemd`), retention 14 päeva.
- Detailid: [`DEPLOYMENT.md`](DEPLOYMENT.md); otsused: [`docs/decisions`](docs/decisions).
