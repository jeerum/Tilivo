# Tilivo

Raamatupidamise SaaS – modulaarne monoliit. Repo hetkeseis on **v0.2 Identity** vastavalt
`raamatupidamise_saas_ARCHITECTURE_v2.md` plaanile. Ärireeglid, arveldamine, pank jne tulevad hilisemates
versioonides. v0.1 pani vundamendi (health, DB, migratsioonid, logi, Trace/Error ID); v0.2 lisab kasutajad,
e-maili kinnituse, sisselogimise, sessioonid, parooli taastamise, TOTP 2FA, recovery codes, rate limitingu ja
auditi.

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
