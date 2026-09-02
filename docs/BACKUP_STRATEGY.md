# Backup-strateegia

## Eesmärk

Tagada andmete taastatavus ja dokumenteerida RPO/RTO siht.

## Siht

- RPO <= 1 tund (kuni infrastruktuur seda võimaldab)
- RTO <= 4 tundi

## Praegu rakendatud

- PostgreSQL volume: eraldi nimeline Docker volume `mrjkp-accounting-db-data`.
- Automaatne backup: systemd oneshot `mrjkp-accounting-backup.service` + timer iga päev 03:17
  (`deploy/systemd/`), skript `deploy/backup.sh`.
- Backup-kaust: `/opt/mrjkp-accounting/backups` (mode 700), backup-failid 600, logi `backup.log`
  ilma paroolideta.
- Retention: 14 päeva (konfigureeritav `RETENTION_DAYS`).
- Restore-test: tehtud PASS – production backup taastati ajutisse `mrjkp_accounting_restore_test` DB-sse,
  kontrolliti tabelid ja pgcrypto, seejärel DB eemaldati.

## Manuaalne käivitus ja kontroll

```bash
systemctl start mrjkp-accounting-backup.service
systemctl status mrjkp-accounting-backup.service
tail -5 /opt/mrjkp-accounting/backups/backup.log
```

## Restore

```bash
gunzip < backups/mrjkp_accounting_XXXX.sql.gz \
  | docker compose exec -T accounting-db psql -U mrjkp_accounting_app -d mrjkp_accounting
```

Restore-test protseduur (ei puuduta production DB-d):

```bash
CREATE DATABASE mrjkp_accounting_restore_test OWNER mrjkp_accounting_app;
gunzip < backup.sql.gz | psql ... -d mrjkp_accounting_restore_test
# integrity check
DROP DATABASE mrjkp_accounting_restore_test;
```

## Põhimõtted

- Production skeemi ei muudeta käsitsi ilma migratsioonita.
- Backup ei ole "working", kuni seda pole taastatud; restore-test kuulub release-protsessi.
- Saladused (`.env`, `server.md`) ei kuulu backup-artefaktidesse, mis repo'sse läheksid.
