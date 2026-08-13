#!/usr/bin/env bash
set -Eeuo pipefail

app_password="$(cat /run/secrets/postgres_app_password)"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$app_password" <<'SQL'
SELECT format(
  'CREATE ROLE petpack_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petpack_app')
\gexec

GRANT CONNECT ON DATABASE petpack_studio TO petpack_app;
SQL

unset app_password
