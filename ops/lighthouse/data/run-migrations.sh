#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${PETPACK_MIGRATION_TEST_MODE:-0}" == 1 ]]; then
  migrations_dir="${PETPACK_MIGRATIONS_DIR:?PETPACK_MIGRATIONS_DIR is required in test mode}"
  admin_password_file="${PETPACK_POSTGRES_ADMIN_PASSWORD_FILE:?PETPACK_POSTGRES_ADMIN_PASSWORD_FILE is required in test mode}"
  app_password_file="${PETPACK_POSTGRES_APP_PASSWORD_FILE:?PETPACK_POSTGRES_APP_PASSWORD_FILE is required in test mode}"
  postgres_ca_file="${PETPACK_POSTGRES_CA_FILE:?PETPACK_POSTGRES_CA_FILE is required in test mode}"
  export PGHOST="${PGHOST:?PGHOST is required in test mode}"
  export PGPORT="${PGPORT:?PGPORT is required in test mode}"
else
  migrations_dir=/migrations
  admin_password_file=/run/secrets/postgres_admin_password
  app_password_file=/run/secrets/postgres_app_password
  postgres_ca_file=/run/tls/ca.crt
  export PGHOST=postgres
  export PGPORT=5432
fi
for required_path in "$migrations_dir" "$admin_password_file" "$app_password_file" "$postgres_ca_file"; do
  if [[ ! -e "$required_path" || -L "$required_path" ]]; then
    printf 'Migration runtime input is missing or unsafe: %s\n' "$required_path" >&2
    exit 1
  fi
done

export PGDATABASE=petpack_studio
export PGUSER=petpack_admin
export PGPASSWORD="$(cat "$admin_password_file")"
export PGSSLMODE=verify-full
if [[ "${PETPACK_MIGRATION_TEST_MODE:-0}" == 1 ]] && command -v cygpath >/dev/null 2>&1; then
  export PGSSLROOTCERT="$(cygpath -w "$postgres_ca_file")"
else
  export PGSSLROOTCERT="$postgres_ca_file"
fi

app_password="$(cat "$app_password_file")"
export PETPACK_MIGRATION_APP_PASSWORD="$app_password"

if find "$migrations_dir" -maxdepth 1 -type l -name '*.sql' | grep -q .; then
  printf 'Migration directory contains a symbolic-link SQL file.\n' >&2
  exit 1
fi
mapfile -t migration_files < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
if (( ${#migration_files[@]} == 0 )); then
  printf 'No SQL migrations found.\n' >&2
  exit 1
fi

for migration in "${migration_files[@]}"; do
  version="$(basename "$migration")"
  if [[ ! "$version" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
    printf 'Migration filename is invalid: %s\n' "$version" >&2
    exit 1
  fi
done

emit_migration_program() {
  cat <<'SQL'
\set ON_ERROR_STOP on
\getenv app_password PETPACK_MIGRATION_APP_PASSWORD
SET lock_timeout = '30s';
SELECT pg_advisory_lock(731209871, 20260813);
RESET lock_timeout;

SELECT format(
  'CREATE ROLE petpack_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petpack_app')
\gexec
GRANT CONNECT ON DATABASE petpack_studio TO petpack_app;

CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

  local migration version checksum
  for migration in "${migration_files[@]}"; do
    version="$(basename "$migration")"
    checksum="$(sha256sum "$migration" | awk '{print $1}')"
    printf '\n\\echo Checking migration %s\n' "$version"
    cat <<SQL
SELECT EXISTS (
         SELECT 1 FROM schema_migration WHERE version = '$version'
       ) AS applied,
       COALESCE((
         SELECT sha256 <> '$checksum' FROM schema_migration WHERE version = '$version'
       ), false) AS mismatch
\gset migration_
\if :migration_mismatch
\echo Applied migration checksum changed: $version
\quit 3
\endif
\if :migration_applied
\echo Already applied: $version
\else
\echo Applying: $version
BEGIN;
SQL
    cat "$migration"
    cat <<SQL

INSERT INTO schema_migration(version, sha256) VALUES ('$version', '$checksum');
COMMIT;
\endif
SQL
  done

  cat <<'SQL'

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

SELECT pg_advisory_unlock(731209871, 20260813);
SQL
}

emit_migration_program | psql --set=ON_ERROR_STOP=1

unset app_password PETPACK_MIGRATION_APP_PASSWORD PGPASSWORD
