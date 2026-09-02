# Backup-strateegia - Tilivo

## Eesmärk ja siht

- RPO <= 1 tund, RTO <= 4 tundi (kuni infrastruktuur võimaldab).
- Backup ei ole "working", kuni seda pole taastatud.

## Praegu rakendatud

- Automaatne backup: systemd `tilivo-backup.service` + `tilivo-backup.timer` (iga päev 03:17),
  skript `deploy/backup.sh`.
- Backup-kaust: `/opt/tilivo/backups` (mode 700), failid 600, logi ilma paroolideta.
- Retention: 14 päeva.
- Restore-test: PASS – backup taastati ajutisse test-DB-sse, kontrolliti tabelid ja pgcrypto,
  seejärel eemaldati.

## Ajaloolised backupid

- Pre-rename failid `mrjkp_accounting_*.sql.gz` on ajalugu ja neid ei nimetata ümber.
- Post-rename failid kasutavad nime `tilivo_accounting_*.sql.gz`.

## Käivitus ja kontroll

```bash
systemctl start tilivo-backup.service
systemctl status tilivo-backup.service
tail -5 /opt/tilivo/backups/backup.log
```

## Restore

```bash
gunzip < backups/tilivo_accounting_XXXX.sql.gz \
  | docker compose exec -T tilivo-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## Põhimõtted

- Production skeemi ei muudeta käsitsi ilma migratsioonita.
- Saladused ei kuulu repo'sse ega backup-logidesse.
