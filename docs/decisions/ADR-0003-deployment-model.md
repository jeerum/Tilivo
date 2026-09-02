# ADR-0003 – Deployment-mudel ja isoleerimine

Kuupäev: 2026-09-02

> Ajakohastatud 2026-09-02 (rename): projekt on nüüd `tilivo`, containerid `tilivo-db/api/web`,
> serveri kaust `/opt/tilivo`, DB `tilivo_accounting`, kasutaja `tilivo_app`. Volume füüsiline nimi
> `mrjkp-accounting-db-data` on teadlikult säilitatud andmete turvalisuseks. Allolev tekst on algse
> otsuse dokumentatsioon.

## Probleem

Serveris töötab juba mitu teenust (nginx, wordgame Docker Compose, multipower, baltik, lahedal, mariadb,
postgresql, postfix, cloudflared jne). Uus raamatupidamise SaaS peab minema turvaliselt kõrvale ilma neid
rikkumata.

## Variandid

1. Paigaldada rakendus otse hosti (systemd + hosti PostgreSQL)
2. Uus isoleeritud Docker Compose projekt oma DB/network/volume/portidega
3. Lisada olemasolevasse wordgame compose'i

## Valik

**Isoleeritud Docker Compose projekt** (`mrjkp`), service-nimed `accounting-*`, network
`mrjkp-accounting`, volume `mrjkp-accounting-db-data`, DB `mrjkp_accounting`, kasutaja
`mrjkp_accounting_app`, host-pordid 3100/3101 ainult `127.0.0.1`.

## Põhjendus

- Serveris on Docker/Compose juba normaalne töömuster – seda mustrit järgime.
- Oma DB/volume/network välistab konflikti wordgame/multipower/lahedal andmetega.
- Ainult localhost-pordid + olemasolev firewall tähendab, et globaalseid reegleid ei muudeta.
- Rollback on lihtne: `docker compose down` puudutab ainult seda projekti.

## Tagajärjed

- Avalikuks kasutuseks on vaja eraldi nginx-isoleeritud vhosti + DNS-i (järgmine samm, kasutaja otsus).
- DB-parool ja .env elavad ainult serveris; repo sisaldab `.env.example`.
