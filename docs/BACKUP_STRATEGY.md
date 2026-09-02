# Backup-strateegia – v0.1

## Eesmärk

Tagada andmete taastatavus ja dokumenteerida RPO/RTO siht.

## Siht

- RPO <= 1 tund (kuni infrastruktuur seda võimaldab)
- RTO <= 4 tundi

## v0.1 baas (praegu rakendatud)

- PostgreSQL volume on eraldi nimeline Docker volume: `mrjkp-accounting-db-data`.
- DB püsib ka siis, kui containerid taaskäivitatakse.
- `pg_dump` on dokumenteeritud viis täis-backup'iks.

## Soovitatav ajastatud backup (serveris, enne reaalseid andmeid)

Näidis crontab (jookseb root'ina):

```cron
15 * * * * docker exec $(docker ps -qf name=mrjkp-accounting-db-1) pg_dump -U mrjkp_accounting_app -d mrjkp_accounting | gzip > /root/mrjkp-backups/mrjkp_accounting_$(date +\%F_\%H).sql.gz
```

NB: see on näidis; enne kasutuselevõttu:

- tee ka krüpteeritud off-site koopia;
- kontrolli backup-monitooringut;
- teosta kord kuus restore-test eraldi keskkonda (backup ei ole "working", kuni seda pole taastatud).

## Restore

```bash
gunzip < backup.sql.gz | docker compose exec -T accounting-db psql -U mrjkp_accounting_app -d mrjkp_accounting
```

## Põhimõtted

- Production skeemi ei muudeta kunagi käsitsi ilma migratsioonita.
- Kustutamist vajavad andmed liiguvad enne kustutamist arhiivi/backupi.
- Saladused (`.env`, server.md) ei kuulu backup-artefaktidesse, mis repo'sse läheksid.

