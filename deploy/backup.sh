#!/usr/bin/env bash
# MRJKP Accounting – project-specific PostgreSQL backup.
# Reads credentials from the project .env; never writes secrets to the log.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env puudub kaustas $PROJECT_DIR" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG_FILE="$BACKUP_DIR/backup.log"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$BACKUP_DIR/mrjkp_accounting_${STAMP}.sql.gz"
TMP_FILE="$OUT_FILE.tmp"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

log() {
  echo "$(date -Is) $*" >> "$LOG_FILE"
}

START_TS="$(date +%s)"
log "backup start"

if docker compose exec -T accounting-db \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    | gzip > "$TMP_FILE"; then
  mv "$TMP_FILE" "$OUT_FILE"
  chmod 600 "$OUT_FILE"
  END_TS="$(date +%s)"
  SIZE="$(stat -c%s "$OUT_FILE")"
  DURATION="$((END_TS - START_TS))"
  log "backup ok file=$(basename "$OUT_FILE") size=${SIZE} duration=${DURATION}s"
  find "$BACKUP_DIR" -maxdepth 1 -name 'mrjkp_accounting_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
  log "retention ok days=${RETENTION_DAYS}"
  exit 0
else
  rm -f "$TMP_FILE"
  log "backup FAILED"
  exit 1
fi

