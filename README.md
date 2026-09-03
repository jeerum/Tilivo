# Tilivo

Raamatupidamise SaaS – modulaarne monoliit. Repo hetkeseis on
**v0.11 (AI Expense Classification) – COMPLETE / GATE PASS**; täpne staatus:
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md). Alates **v0.7.5** kehtib uus plaan
[`ROADMAP.md`](ROADMAP.md): v0.7.5 (Business Registry) on viimane "vana plaani" punkt, seejärel ehitatakse
täisväärtuslikku Soome raamatupidamistarkvara (Accounting/ERP), mitte enam lihtsalt arvete programmi.

Varasemad verstapostid: v0.1 infrastruktuur, v0.2 Identity/2FA, v0.3 tenants/companies/memberships/rollid +
PostgreSQL Row Level Security, v0.4 desktop AppShell + audit + dokumendid, v0.5 Accounting Core, v0.6 Sales,
v0.7 Purchases + e-arve foundation, v0.7.5 Business Registry integration (PRH YTJ Soome äriregistri otsing
kliendi/tarnija voogudesse), v0.8 Accounting Core 1 (opening balances,
dimensioonivalmidus, source-traceability, reversali linkid, konto aktiivsus).

## Avalik kasutus

```text
https://tilivo.mrjaak.com
```

Let's Encrypt sertifikaat on olemas ja uueneb automaatselt; nginx-vhost on isoleeritud ainult sellele
domeenile ja proksib `127.0.0.1:3101`-le.

## Repo struktuur

```text
apps/
  api/     # Fastify + TypeScript backend, /api/v1, OpenAPI, node-pg-migrate
  web/     # React + TypeScript + Vite frontend (keel: ET/EN)
compose.yaml
docs/
  decisions/      # ADR-id
deploy/
```

## Tehnoloogiapinu (v0.1)

- Backend: Node.js 22 LTS, TypeScript, Fastify 5
- Andmebaas: PostgreSQL 17 (isoleeritud Docker volume)
- Migratsioonid: node-pg-migrate (source control'is)
- Konfiguratsioon: environment + Zod validaator
- Frontend: React 19, TypeScript, Vite 6
- Deploy: isoleeritud Docker Compose projekt (`tilivo`)
- Logid: pino struktureeritud JSON; iga request seotud `trace_id`-ga
- Paroolid: Argon2id; tokenid DB-s hash'itult; TOTP secret AES-256-GCM krüpteeritult

## Identity API (v0.2)

```text
POST /api/v1/auth/register
POST /api/v1/auth/email/verify
POST /api/v1/auth/email/resend
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
GET  /api/v1/auth/sessions
POST /api/v1/auth/sessions/:id/revoke
POST /api/v1/auth/sessions/revoke-others
POST /api/v1/auth/password/forgot
POST /api/v1/auth/password/reset
POST /api/v1/auth/password/change
POST /api/v1/auth/2fa/setup
POST /api/v1/auth/2fa/confirm
POST /api/v1/auth/2fa/disable
POST /api/v1/auth/2fa/recovery-codes
```

Turvamudel on kirjeldatud [`docs/IDENTITY_SECURITY.md`](docs/IDENTITY_SECURITY.md).

## Accounting API (v0.5 + v0.8)

```text
GET/POST   /api/v1/accounts
GET/POST   /api/v1/fiscal-years
GET/POST   /api/v1/accounting-periods
PATCH/POST /api/v1/accounting-periods/:id | /:id/reopen
GET/POST   /api/v1/journals
GET        /api/v1/journals/:id
POST       /api/v1/journals/:id/post | /:id/reverse
POST       /api/v1/opening-balances
GET        /api/v1/ledger
GET        /api/v1/accounts/:id/ledger
GET        /api/v1/reports/trial-balance
GET/POST/PATCH /api/v1/tax-codes
GET/POST/PATCH/DELETE /api/v1/fx-rates
GET        /api/v1/fx-rates/convert
GET        /api/v1/currencies
```

Ülevaade: [`docs/ACCOUNTING_CORE.md`](docs/ACCOUNTING_CORE.md) ja ADR-id
`docs/decisions/ADR-0010..0015`.

## Business Registry API (v0.7.5)

```text
GET /api/v1/business-registry/search?q=<nimi või Y-tunnus>
GET /api/v1/business-registry/companies/:businessId
```

Provider: PRH YTJ open data v3 (Soome äriregistri avalik andmeallikas, tasuta, API-võtit ei ole).
Kliendi/tarnija vormides on registriotsing assistent – andmed täidetakse vormile ja kasutaja kinnitab need
enne salvestamist; registriinfo (source, source_id, fetched_at, snapshot) säilitatakse party küljes.
Üksikasjad, kaardistus ja limiidid: [`docs/BUSINESS_REGISTRY.md`](docs/BUSINESS_REGISTRY.md).

## Kohalik arendus

```bash
# eeldus: PostgreSQL jookseb lokaalselt või Dockeris
cp .env.example .env
cd apps/api && cp .env.example .env   # täida DATABASE_URL
cd apps/web && npm install
npm run dev:api
npm run dev:web
```

Kontrollid:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Täpsem deploy kirjeldus: [`DEPLOYMENT.md`](DEPLOYMENT.md). Serveri saladusi (nt `server.md`) ei tohi kunagi
committida; see on ka `.gitignore`'is.
