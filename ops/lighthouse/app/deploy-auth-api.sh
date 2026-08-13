#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "deploy-auth-api.sh must run as root" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${PETPACK_DATA_CONFIG_DIR:-/opt/petpack/config/data}"
SECRETS_DIR="${SCRIPT_DIR}/secrets"

require_file() {
  local file="$1"
  [[ -f "${file}" && ! -L "${file}" ]] || { echo "Required file is missing: ${file}" >&2; exit 1; }
}

require_file "${DATA_DIR}/secrets/postgres_app_password"
require_file "${DATA_DIR}/secrets/redis_password"
require_file "${DATA_DIR}/tls/ca.crt"
install -d -m 0700 "${SECRETS_DIR}"

if [[ ! -s "${SECRETS_DIR}/session_signing_key" ]]; then
  umask 077
  openssl rand -base64 48 | tr -d '\n' > "${SECRETS_DIR}/session_signing_key"
fi

POSTGRES_PASSWORD="$(<"${DATA_DIR}/secrets/postgres_app_password")"
ENCODED_PASSWORD="$(printf '%s' "${POSTGRES_PASSWORD}" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
printf 'postgresql://petpack_app:%s@postgres:5432/petpack_studio?sslmode=verify-full' "${ENCODED_PASSWORD}" > "${SECRETS_DIR}/postgres_url"
REDIS_PASSWORD="$(<"${DATA_DIR}/secrets/redis_password")"
ENCODED_REDIS_PASSWORD="$(printf '%s' "${REDIS_PASSWORD}" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
printf 'rediss://petpack:%s@redis:6379/0' "${ENCODED_REDIS_PASSWORD}" > "${SECRETS_DIR}/redis_url"
install -m 0600 "${DATA_DIR}/tls/ca.crt" "${SECRETS_DIR}/postgres_ca"
chown 10001:10001 "${SECRETS_DIR}/postgres_url" "${SECRETS_DIR}/postgres_ca" "${SECRETS_DIR}/redis_url" "${SECRETS_DIR}/session_signing_key"
chmod 0400 "${SECRETS_DIR}/postgres_url" "${SECRETS_DIR}/postgres_ca" "${SECRETS_DIR}/redis_url" "${SECRETS_DIR}/session_signing_key"
unset POSTGRES_PASSWORD ENCODED_PASSWORD REDIS_PASSWORD ENCODED_REDIS_PASSWORD

cd "${SCRIPT_DIR}"
docker compose build --pull auth-api
docker compose up -d auth-api

for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' petpack-auth-api 2>/dev/null || true)"
  [[ "${status}" == "healthy" ]] && break
  [[ "${status}" == "unhealthy" ]] && { docker logs --tail 80 petpack-auth-api >&2; exit 1; }
  sleep 2
done

[[ "$(docker inspect --format '{{.State.Health.Status}}' petpack-auth-api)" == "healthy" ]] || {
  docker logs --tail 80 petpack-auth-api >&2
  exit 1
}

docker exec petpack-auth-api node -e \
  "fetch('http://127.0.0.1:8787/healthz').then(async r=>{const b=await r.json();if(r.status!==200||b.database!=='ready')process.exit(1);console.log('auth_api=healthy database=ready')})"
