#!/usr/bin/env bash
set -Eeuo pipefail

export PGHOST=postgres
export PGPORT=5432
export PGDATABASE=petpack_studio
export PGUSER=petpack_admin
export PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/run/tls/ca.crt

app_password="$(cat /run/secrets/postgres_app_password)"
psql --set=ON_ERROR_STOP=1 --set=app_password="$app_password" <<'SQL'
SELECT format(
  'CREATE ROLE petpack_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petpack_app')
\gexec
GRANT CONNECT ON DATABASE petpack_studio TO petpack_app;
SQL
unset app_password

psql --set=ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

shopt -s nullglob
migration_files=(/migrations/*.sql)
if (( ${#migration_files[@]} == 0 )); then
  printf 'No SQL migrations found.\n' >&2
  exit 1
fi

for migration in "${migration_files[@]}"; do
  version="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  escaped_version="$(printf '%s' "$version" | sed "s/'/''/g")"
  stored_checksum="$(psql --tuples-only --no-align \
    --command="SELECT sha256 FROM schema_migration WHERE version = '$escaped_version';")"

  if [[ -n "$stored_checksum" ]]; then
    if [[ "$stored_checksum" != "$checksum" ]]; then
      printf 'Applied migration checksum changed: %s\n' "$version" >&2
      exit 1
    fi
    printf 'Already applied: %s\n' "$version"
    continue
  fi

  printf 'Applying: %s\n' "$version"
  {
    printf '\\set ON_ERROR_STOP on\nBEGIN;\n'
    cat "$migration"
    printf "\nINSERT INTO schema_migration(version, sha256) VALUES ('%s', '%s');\nCOMMIT;\n" \
      "$escaped_version" "$checksum"
  } | psql --set=ON_ERROR_STOP=1
done

psql --set=ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO petpack_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO petpack_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO petpack_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO petpack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE petpack_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO petpack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE petpack_admin IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO petpack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE petpack_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO petpack_app;
SQL

unset PGPASSWORD
