#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Data verification failed at line %s.\n" "$LINENO" >&2' ERR

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"
expected_migration_count="$(find "$script_dir/../../../platform/sql" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
[[ "$expected_migration_count" =~ ^[1-9][0-9]*$ ]]

postgres_health="$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-postgres)"
redis_health="$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-redis)"
[[ "$postgres_health" == healthy ]]
[[ "$redis_health" == healthy ]]

if sudo ss -lnt | grep -Eq ':(5432|6379)[[:space:]]'; then
  printf 'A database port is unexpectedly published on the host.\n' >&2
  exit 1
fi

postgres_result="$(sudo docker run --rm \
  --network petpack-data \
  --volume "$script_dir/secrets:/run/secrets:ro" \
  --volume "$script_dir/tls/ca.crt:/run/tls/ca.crt:ro" \
  postgres:18.4-bookworm bash -Eeuo pipefail -c '
    export PGPASSWORD="$(cat /run/secrets/postgres_app_password)"
    export PGSSLMODE=verify-full
    export PGSSLROOTCERT=/run/tls/ca.crt
    psql --host=postgres --username=petpack_app --dbname=petpack_studio \
      --tuples-only --no-align \
      --command="SELECT current_user || '\''|'\'' || (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) || '\''|'\'' || (SELECT count(*) FROM schema_migration) || '\''|'\'' || (SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\'');"
    unset PGPASSWORD
  ')"

IFS='|' read -r app_role tls_enabled migration_count table_count <<<"$postgres_result"
[[ "$app_role" == petpack_app ]]
[[ "$tls_enabled" == true ]]
[[ "$migration_count" == "$expected_migration_count" ]]
[[ "$table_count" =~ ^[1-9][0-9]*$ ]]

checksums="$(sudo docker exec -u postgres petpack-postgres psql \
  --username=petpack_admin --dbname=petpack_studio \
  --tuples-only --no-align --command='SHOW data_checksums;')"
[[ "$checksums" == on ]]

redis_result="$(sudo docker exec petpack-redis bash -Eeuo pipefail -c '
  export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"
  redis-cli --tls --cacert /run/tls/ca.crt --user petpack ping
  unset REDISCLI_AUTH
')"
[[ "$redis_result" == PONG ]]

latest_backup="$(sudo find /opt/petpack/shared/backups/postgres -maxdepth 1 \
  -type f -name 'petpack_studio-*.dump' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "$latest_backup" ]]
sudo test -s "$latest_backup"
sudo cat "$latest_backup" | \
  sudo docker exec -i -u postgres petpack-postgres pg_restore --list >/dev/null

grep -Fq '/usr/local/sbin/petpack-backup-postgres' /etc/cron.d/petpack-postgres-backup
[[ "$(sudo docker network inspect petpack-data --format='{{.Internal}}')" == true ]]
curl -fsS https://api.heyirmy.com/health >/dev/null

printf 'postgres=%s tls=%s migrations=%s tables=%s checksums=%s\n' \
  "$postgres_health" "$tls_enabled" "$migration_count" "$table_count" "$checksums"
printf 'redis=%s tls_auth=ok\n' "$redis_health"
printf 'host_ports=closed docker_network=internal backup=verified cron=installed edge=healthy\n'
