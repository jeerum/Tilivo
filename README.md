# MRJKP Accounting

Raamatupidamise SaaS – modulaarne monoliit. See repo on v0.1 ehk **infrastruktuuri ja vundamendi** etapp vastavalt
`raamatupidamise_saas_ARCHITECTURE_v2.md` plaanile. Ärireeglid, arveldamine, pank jne tulevad hilisemates
versioonides; v0.1 lõpeb sellega, et serveris töötab tervisekontroll, andmebaasiühendus, frontend, migratsioonid,
struktureeritud logi, Trace ID ja Error ID.

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
- Deploy: isoleeritud Docker Compose projekt (`mrjkp`)
- Logid: pino struktureeritud JSON; iga request seotud `trace_id`-ga

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

