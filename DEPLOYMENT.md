# Deploy - MRJKP Accounting

## Praegune seis (v0.2)

Deploy on tehtud VPS-ile (locoforum) **isoleeritult**, ilma olemasolevaid teenuseid puutumata:

| Komponent | Väärtus |
| --- | --- |
| Kataloog serveris | `/opt/mrjkp-accounting` |
| Compose projekt | `mrjkp` (compose `name:`) |
| Service nimed | `accounting-api`, `accounting-web`, `accounting-db`, `accounting-test` |
| Network | `mrjkp-accounting` |
| Volume | `mrjkp-accounting-db-data` |
| DB nimi | `mrjkp_accounting` (test: `mrjkp_accounting_test`) |
| DB kasutaja | `mrjkp_accounting_app` |
| API host-port | `127.0.0.1:3100` (containeris `3000`) |
| Web host-port | `127.0.0.1:3101` (containeris `80`) |
| Backup | systemd timer `mrjkp-accounting-backup.timer`, iga päev 03:17, retention 14 päeva |

Pordid 3100/3101 on valitud vabana (olemasolevad: 22, 25, 53, 80, 443, 323, 3306, 3800, 5432, 8081, 8090,
8787, 20241 jt). Containerid kuulavad ainult `127.0.0.1`, firewalli reegleid ei muudeta.

## Turvalisus ja saladused

- `server.md` ja `.env` on `.gitignore`'is ning ei tohi kunagi repo'sse minna.
- Serveri `.env` on root-only (`600`); paroolid genereeritakse juhuslikult.
- v0.2 alates on `.env`-s `TOTP_ENCRYPTION_KEY` (64 hex-märki, `openssl rand -hex 32`).
- Logidest on päised (authorization/cookie) ja parooliväljad redakteeritud.

## Deploy käsk (serveril)

```bash
cd /opt/mrjkp-accounting
./deploy/remote-deploy.sh
```

Sammud, mida skript teeb:

1. valideerib `.env`;
2. tõstab DB, API ja Web containerid üles (build);
3. jooksutab migratsioonid (`node dist/migrate.js up`);
4. teeb smoke-testid: API health, web, web->API;
5. väljastab `docker compose ps`.

Backup:

```bash
systemctl start mrjkp-accounting-backup.service   # kohene backup
ls -la /opt/mrjkp-accounting/backups              # .sql.gz + backup.log, ainult root loeb
systemctl list-timers mrjkp-accounting-backup.timer
```

## Integration-testid (vajavad DB-d)

```bash
cd /opt/mrjkp-accounting
set -a; . ./.env; set +a
docker compose exec -T accounting-db psql -U "$POSTGRES_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='mrjkp_accounting_test'" | grep -q 1 || \
docker compose exec -T accounting-db psql -U "$POSTGRES_USER" -d postgres -c \
  "CREATE DATABASE mrjkp_accounting_test OWNER $POSTGRES_USER"
docker compose --profile test run --rm --build accounting-test
```

## Rollback

Kogu stack on isoleeritud, seega tagasipööre on:

```bash
cd /opt/mrjkp-accounting
docker compose down
```

Volume jääb alles (andmed säilivad). Enne täielikku eemaldamist tee DB backup:

```bash
docker compose exec -T accounting-db pg_dump -U "$POSTGRES_USER" -d mrjkp_accounting > backup.sql
```

Olemasolevaid teenuseid (nginx, wordgame, multipower, baltik, lahedal, mariadb, postfix jne) rollback ei
puuduta.

## Identity ja e-mail

- Productionis on hetkel `EMAIL_DRIVER=noop` (kirju ei saadeta), kuni SMTP credentials on olemas.
- Arendus/test kasutab `dev` driverit, mis kirjutab kirjad `dev_email_outbox` tabelisse.
- Avalikku registreerimist ega DNS-i pole sisse lülitatud; enne avalikku kasutust tehakse security review.

## Avalik avamine (järgmine samm, vajab kasutaja DNS-otsust)

1. valida alamdomeen;
2. lisada DNS A/AAAA kirje serveri IP-le (või Cloudflare Tunnel route);
3. hankida Let's Encrypt sertifikaat;
4. aktiveerida `deploy/nginx-accounting.conf.example` sisu isoleeritud nginx site-failina
   (enne muudatust tee backup ja valideeri `nginx -t`).

Ilma DNS-ita ei lisa me serveri globaalsesse nginx-i aktiivset vhosti.
