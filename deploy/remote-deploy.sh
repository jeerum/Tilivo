#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "ERROR: .env puudub. Kopeeri .env.example ja täida väärtused." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

docker compose config -q

echo "==> build + up db"
docker compose up -d --build tilivo-db

echo "==> ensure runtime db role"
./deploy/ensure-runtime-role.sh

echo "==> build + up api and web"
docker compose up -d --build tilivo-api tilivo-web

echo "==> migrations"
docker compose run --rm --no-deps tilivo-api node dist/migrate.js up

echo "==> smoke tests"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${API_HOST_PORT:-3100}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -fsS "http://127.0.0.1:${API_HOST_PORT:-3100}/api/v1/health"
echo
curl -fsS -o /dev/null -w "web http %{http_code}\n" "http://127.0.0.1:${WEB_HOST_PORT:-3101}/"
curl -fsS -o /dev/null -w "web->api http %{http_code}\n" "http://127.0.0.1:${WEB_HOST_PORT:-3101}/api/v1/health"

echo "==> compose ps"
docker compose ps
