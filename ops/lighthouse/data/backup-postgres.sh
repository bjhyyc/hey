#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="/opt/petpack/shared/backups/postgres"
retention_days="${PETPACK_BACKUP_RETENTION_DAYS:-7}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_path="$backup_dir/petpack_studio-$timestamp.dump"
temp_path="$final_path.tmp"

install -d -m 0700 "$backup_dir"
trap 'rm -f -- "$temp_path"' EXIT

docker exec -u postgres petpack-postgres pg_dump \
  --username=petpack_admin --dbname=petpack_studio \
  --format=custom --compress=9 > "$temp_path"

test -s "$temp_path"
docker exec -i -u postgres petpack-postgres pg_restore --list < "$temp_path" >/dev/null
chmod 0600 "$temp_path"
mv -- "$temp_path" "$final_path"
trap - EXIT

find "$backup_dir" -type f -name 'petpack_studio-*.dump' -mtime "+$retention_days" -delete

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
