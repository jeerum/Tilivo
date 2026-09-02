#!/bin/bash
set -euo pipefail

if [[ -z "${TILIVO_RUNTIME_PASSWORD:-}" ]]; then
  echo "TILIVO_RUNTIME_PASSWORD is required" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tilivo_runtime') THEN CREATE ROLE tilivo_runtime LOGIN PASSWORD '${TILIVO_RUNTIME_PASSWORD}'; ELSE ALTER ROLE tilivo_runtime WITH LOGIN PASSWORD '${TILIVO_RUNTIME_PASSWORD}'; END IF; END \$\$;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "GRANT CONNECT ON DATABASE \"$POSTGRES_DB\" TO tilivo_runtime"
