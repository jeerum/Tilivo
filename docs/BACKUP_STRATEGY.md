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

### Document object restore (SHA-256 verified)

```bash
BACKUP="$(ls -t /opt/tilivo/backups/tilivo_documents_*.tar.gz | head -1)"
TMPDIR="$(mktemp -d /tmp/tilivo-restore.XXXXXX)"
tar -xzf "$BACKUP" -C "$TMPDIR"
# compare each restored file with document_versions.sha256 (storage_key ilma documents/ prefiksita)
find "$TMPDIR" -type f -print0 | while IFS= read -r -d '' file; do
  rel="${file#"$TMPDIR"/}"; rel="${rel#documents/}"
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  db="$(docker exec tilivo-db psql -U tilivo_app -d tilivo_accounting -tAc \
    "SELECT sha256 FROM document_versions WHERE storage_key = '$rel' LIMIT 1")"
  [ "$db" = "$sha" ] || { echo "MISMATCH $rel"; exit 1; }
done
rm -rf "$TMPDIR"
```

- Restore läheb alati eraldi temp-kataloogi; production volume'i ei kirjutata üle.
- Failure => non-zero exit.

## Põhimõtted

- Production skeemi ei muudeta käsitsi ilma migratsioonita.
- Saladused ei kuulu repo'sse ega backup-logidesse.
