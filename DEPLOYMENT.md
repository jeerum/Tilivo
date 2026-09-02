# Deploy – MRJKP Accounting v0.1

## Praegune seis (v0.1)

Esimene v0.1 deploy on tehtud VPS-ile (locoforum) **isoleeritult**, ilma olemasolevaid teenuseid puutumata:

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

Pordid 3100/3101 on valitud vabana (olemasolevad: 22, 25, 53, 80, 443, 323, 3306, 3800, 5432, 8081, 8090,
8787, 20241 jt). Containerid kuulavad ainult `127.0.0.1`, firewalli reegleid ei muudeta.

## Turvalisus ja saladused

- `server.md` (serveri ühendusandmed) ja `.env` on `.gitignore`'is ning ei tohi kunagi repo'sse minna.
- Serveri `.env` luuakse `.env.example` põhjal; parool genereeritakse juhuslikult ja salvestatakse `600`
  õigustega.
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
4. teeb smoke-testid:
   - `GET http://127.0.0.1:3100/api/v1/health`
   - `GET http://127.0.0.1:3101/`
   - `GET http://127.0.0.1:3101/api/v1/health`
5. väljastab `docker compose ps`.

## Integration-testid (vajavad DB-d)

```bash
cd /opt/mrjkp-accounting
set -a; . ./.env; set +a
docker compose exec -T accounting-db psql -U "$POSTGRES_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='mrjkp_accounting_test'" | grep -q 1 || \
docker compose exec -T accounting-db psql -U "$POSTGRES_USER" -d postgres -c \
  "CREATE DATABASE mrjkp_accounting_test OWNER $POSTGRES_USER"
docker compose --profile test run --rm accounting-test
```

## Rollback

Kogu uus stack on isoleeritud, seega tagasipööre on:

```bash
cd /opt/mrjkp-accounting
docker compose down            # peatab ja eemaldab ainult mrjkp projekti containerid
```

Volume jääb alles (andmed säilivad). Täieliku eemaldamise korral enne kustutamist tee DB backup:

```bash
docker compose exec -T accounting-db pg_dump -U "$POSTGRES_USER" -d mrjkp_accounting > backup.sql
```

Olemasolevaid teenuseid (nginx, wordgame, multipower, baltik, lahedal, mariadb, postfix jne) rollback ei
puuduta – neile me muudatusi ei tee.

## Avalik avamine (järgmine samm, vajab kasutaja DNS-otsust)

Containerid kuulavad praegu ainult localhostis. Avalikuks kasutuseks tuleb:

1. valida alamdomeen (nt `accounting.mrjaak.com` või mõni teine kasutaja domeen);
2. lisada DNS A/AAAA kirje serveri IP-le (või Cloudflare Tunnel route);
3. hankida Let's Encrypt sertifikaat;
4. aktiveerida `deploy/nginx-accounting.conf.example` sisu isoleeritud nginx site-failina
   (enne muudatust tee olemasolevast konfigist backup ja valideeri `nginx -t`).

Ilma DNS-ita ei lisa me serveri globaalsesse nginx-i aktiivset vhosti.

