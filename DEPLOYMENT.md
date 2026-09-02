# Deploy - Tilivo

## Praegune seis (v0.2 + rename Tilivo)

Tilivo on deploy'tud VPS-ile (locoforum) **isoleeritult**, ilma olemasolevaid teenuseid puutumata:

| Komponent | Väärtus |
| --- | --- |
| Kataloog serveris | `/opt/tilivo` |
| Compose projekt | `tilivo` |
| Containerid | `tilivo-db`, `tilivo-api`, `tilivo-web` |
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
docker compose --profile test run --rm --build tilivo-test
```

## Rollback

```bash
cd /opt/tilivo
docker compose down
```

Volume jääb alles. Enne täielikku eemaldamist tee DB backup:

```bash
docker compose exec -T tilivo-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backup.sql
```

## Legacy / ajalooline

- `/opt/mrjkp-accounting` (kui eksisteerib) on pre-rename koopia, mida ei käivitata; seda ei kustutata
  enne eraldi kokkulepet.
- Vanad backup-failid `mrjkp_accounting_*.sql.gz` on pre-rename ajalugu ja neid ei nimetata ümber.
- Füüsiline Docker volume nimi `mrjkp-accounting-db-data` on teadlik legacy identifier.

## Identity ja e-mail

- Production `EMAIL_DRIVER=noop` kuni SMTP credentials on olemas.
- Avalikku DNS-i/nginx site'i pole sisse lülitatud.
