#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir="/opt/petpack/shared/backups/postgres"
retention_days="${PETPACK_BACKUP_RETENTION_DAYS:-7}"
if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ || "$retention_days" -gt 365 ]]; then
  printf 'PETPACK_BACKUP_RETENTION_DAYS must be between 1 and 365.\n' >&2
  exit 1
fi
if [[ -L "$backup_dir" ]]; then
  printf 'Backup directory must not be a symbolic link.\n' >&2
  exit 1
fi
install -d -m 0700 "$backup_dir"
if [[ "$(readlink -f -- "$backup_dir")" != "$backup_dir" ]]; then
  printf 'Backup directory must not traverse a symbolic link.\n' >&2
  exit 1
fi

exec 9>/run/lock/petpack-postgres-backup.lock
if ! flock -n 9; then
  printf 'Another PostgreSQL backup is already running.\n' >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$backup_dir/petpack_studio-$timestamp.dump"
temp_path="$final_path.tmp"

trap 'rm -f -- "$temp_path"' EXIT

docker exec -u postgres petpack-postgres pg_dump \
  --username=petpack_admin --dbname=petpack_studio \
  --format=custom --compress=9 > "$temp_path"

test -s "$temp_path"
docker exec -i -u postgres petpack-postgres pg_restore --list < "$temp_path" >/dev/null
chmod 0600 "$temp_path"
mv -- "$temp_path" "$final_path"
trap - EXIT

find "$backup_dir" -maxdepth 1 -type f -name 'petpack_studio-*.dump' \
  -mtime "+$retention_days" -delete

if [[ "${1:-}" == "--verify-restore" ]]; then
  restore_db="petpack_restore_check_${timestamp//[^0-9]/}"
  cleanup_restore() {
    docker exec -u postgres petpack-postgres dropdb \
      --username=petpack_admin --if-exists "$restore_db" >/dev/null 2>&1 || true
  }
  trap cleanup_restore EXIT
  docker exec -u postgres petpack-postgres createdb \
    --username=petpack_admin "$restore_db"
  docker exec -i -u postgres petpack-postgres pg_restore \
    --username=petpack_admin --dbname="$restore_db" \
    --no-owner --no-privileges < "$final_path"
  table_count="$(docker exec -u postgres petpack-postgres psql \
    --username=petpack_admin --dbname="$restore_db" \
    --tuples-only --no-align \
    --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
  [[ "$table_count" =~ ^[1-9][0-9]*$ ]]
  cleanup_restore
  trap - EXIT
fi

printf '%s\n' "$final_path"
