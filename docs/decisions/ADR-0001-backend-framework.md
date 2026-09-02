# ADR-0001 – Backend framework ja repo ülesehitus

Kuupäev: 2026-09-02

## Probleem

v0.1 jaoks tuleb lukustada konservatiivne, pikaajaliselt hooldatav stack, mis töötab hästi Linuxis ja
toetab tulevast modulaarset monoliiti (Identity, Accounting, Sales jne ühes protsessis).

## Variandid

1. NestJS (TypeScript, DI, suur ökosüsteem, rohkem boilerplate'i)
2. Fastify (TypeScript, kiire, sisseehitatud JSON Schema valideerimine, pino logi, plugin-ökosüsteem)
3. Express (kõige levinum, aga vähem sisseehitatud struktuuri)
4. Go/Java/Python alternatiivid (tugevad, aga erinev keel frontendist)

## Valik

**Node.js 22 LTS + TypeScript + Fastify 5**, frontend **React 19 + Vite**, monorepo `apps/api` + `apps/web`.

## Põhjendus

- Üks keel (TypeScript) kogu stackis vähendab kontekstivahetust.
- Fastify annab kiiresti API versiooni, JSON Schema response-valideerimise, request-id/Trace ID toe ja
  struktureeritud pino logi ilma raske raamistikuta.
- React + Vite on stabiilne, lai ökosüsteem ja sobib hele lihtsa UI-ga.
- Moodulid lisatakse hiljem sama protsessi (modulaarne monoliit), mikroteenuseid ei tehta.

## Tagajärjed

- Koodis on selge module/service piir vajalik; abstraktsioone lisatakse alles vajadusel.
- Fastify 6 väljavahetamisel on API-kiht õhuke ja migreeritav.

