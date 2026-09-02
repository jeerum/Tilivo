#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env puudub" >&2
  exit 1
fi
set -a
. ./.env
set +a

if [[ -z "${TILIVO_RUNTIME_PASSWORD:-}" ]]; then
  RUNTIME_PW="$(openssl rand -hex 24)"
  printf 'TILIVO_RUNTIME_PASSWORD=%s\n' "$RUNTIME_PW" >> .env
  set -a
  . ./.env
  set +a
fi

docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tilivo_runtime') THEN
    CREATE ROLE tilivo_runtime LOGIN PASSWORD '${TILIVO_RUNTIME_PASSWORD}';
  ELSE
    ALTER ROLE tilivo_runtime WITH LOGIN PASSWORD '${TILIVO_RUNTIME_PASSWORD}';
  END IF;
END
\$\$;
SQL

docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres \
  -c "GRANT CONNECT ON DATABASE \"$POSTGRES_DB\" TO tilivo_runtime"
docker exec tilivo-db psql -U "$POSTGRES_USER" -d postgres \
  -c 'GRANT CONNECT ON DATABASE "tilivo_accounting_test" TO tilivo_runtime' >/dev/null 2>&1 || true
echo "runtime role ready"
