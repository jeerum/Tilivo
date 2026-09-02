# Deploy - Tilivo

## Avalik aadress

```text
https://tilivo.mrjaak.com
```

- DNS: `tilivo.mrjaak.com -> 152.53.160.197` (A-rekord).
- Sertifikaat: Let's Encrypt, automaatne renew.
- Nginx: isoleeritud site `tilivo.mrjaak.com`, proksib `127.0.0.1:3101`; HTTP -> HTTPS.
- Rakenduse `APP_BASE_URL=https://tilivo.mrjaak.com`.

## Praegune seis (v0.6 Sales)

Tilivo on deploy'tud VPS-ile (locoforum) **isoleeritult**, ilma olemasolevaid teenuseid puutumata:

| Komponent | Väärtus |
| --- | --- |
| Kataloog serveris | `/opt/tilivo` |
| Compose projekt | `tilivo` |
| Containerid | `tilivo-db`, `tilivo-api`, `tilivo-web`, `tilivo-worker` |
| Network | `tilivo` |
| Volume (füüsiline nimi) | `mrjkp-accounting-db-data` – legacy nimi säilitatud, et andmeid mitte kaotada |
| DB nimi | `tilivo_accounting` (test: `tilivo_accounting_test`) |
| DB kasutaja | `tilivo_app` |
| API host-port | `127.0.0.1:3100` (containeris `3000`) |
| Web host-port | `127.0.0.1:3101` (containeris `80`) |
| Backup | systemd timer `tilivo-backup.timer`, iga päev 03:17, retention 14 päeva |

Porte 3100/3101 ei muudetud. Containerid kuulavad ainult `127.0.0.1`, firewalli reegleid ei muudeta.

## Turvalisus ja saladused

- `server.md` ja `.env` on `.gitignore`'is.
- Serveri `.env` on root-only (`600`).
- `.env` sisaldab `TOTP_ENCRYPTION_KEY` (sama väärtus kui enne rename'i – olemasolevad TOTP
  secret'id peavad jääma dekrüpteeritavaks).
- Logidest on päised ja parooliväljad redakteeritud.

## Deploy käsk (serveril)

```bash
cd /opt/tilivo
./deploy/remote-deploy.sh
```

v0.6 lisab workerile dokumendimahu (`tilivo-document-storage` on jagatud api ja
workeriga) ning käivitab migratsiooni `20260903100000_sales_core` enne workeri
üles toomist. `remote-deploy.sh` teeb selle automaatselt:

```text
db up -> ensure roles -> api/web build+up -> migrate up -> worker up -> smoke
```

Sales smoke on kaetud `tmp_create_e2e.sh` + Playwright `sales.spec.ts` abil
(QA tenant 'E2E Accounting QA Tenant').

Backup:

```bash
systemctl start tilivo-backup.service
ls -la /opt/tilivo/backups
systemctl list-timers tilivo-backup.timer
```

## Integration-testid

```bash
cd /opt/tilivo
set -a; . ./.env; set +a
# Hermeetiline jooks: nullib tilivo_accounting_test enne migratsiooni + testi
docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS tilivo_accounting_test"
docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE tilivo_accounting_test OWNER $POSTGRES_USER"
docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres -c "GRANT CONNECT ON DATABASE tilivo_accounting_test TO tilivo_runtime, tilivo_worker"
docker compose --profile test run --rm --build tilivo-test
```

Vaikimisi jookseb kogu suite; osaliseks jooksuks anna `TEST_FILTER` (nt
`TEST_FILTER='tests/accounting' docker compose --profile test run --rm --build tilivo-test`).

## v0.5 production migrate

Enne esimest v0.5 migratsiooni tehakse DB backup + restore-test isoleeritud
DB-sse. Deploy ja migratsioon:

```bash
cd /opt/tilivo
./deploy/remote-deploy.sh
docker compose run --rm --no-deps tilivo-api node dist/migrate.js up
```

Uued migratsioonid: `20260902220000_accounting_core`,
`20260903000000_accounting_hardening`, `20260903010000_tax_codes_unique`.

## Rollback

```bash
cd /opt/tilivo
docker compose down
```

Volume jääb alles. Enne täielikku eemaldamist tee DB backup:

```bash
docker compose exec -T tilivo-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backup.sql
```

Document-object restore protseduur on [docs/BACKUP_STRATEGY.md](docs/BACKUP_STRATEGY.md) –
temp-kataloog, SHA-256 võrdlus DB-ga, cleanup, production volume'i ei kirjutata üle.

## Legacy / ajalooline

- `/opt/mrjkp-accounting` (kui eksisteerib) on pre-rename koopia, mida ei käivitata; seda ei kustutata
  enne eraldi kokkulepet.
- Vanad backup-failid `mrjkp_accounting_*.sql.gz` on pre-rename ajalugu ja neid ei nimetata ümber.
- Füüsiline Docker volume nimi `mrjkp-accounting-db-data` on teadlik legacy identifier.

## Identity ja e-mail

- Production `EMAIL_DRIVER=noop` kuni SMTP credentials on olemas.
- Avalikku DNS-i/nginx site'i pole sisse lülitatud.
