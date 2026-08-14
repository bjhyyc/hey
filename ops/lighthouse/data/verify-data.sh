#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Data verification failed at line %s.\n" "$LINENO" >&2' ERR

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

config_root="${PETPACK_DATA_CONFIG_ROOT:-/opt/petpack/config/data}"
postgres_image="${PETPACK_POSTGRES_IMAGE:-}"
redis_image="${PETPACK_REDIS_IMAGE:-}"
if [[ ! "$postgres_image" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
  printf 'PETPACK_POSTGRES_IMAGE must be an immutable repository@sha256 image reference.\n' >&2
  exit 1
fi
if [[ ! "$redis_image" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
  printf 'PETPACK_REDIS_IMAGE must be an immutable repository@sha256 image reference.\n' >&2
  exit 1
fi
if [[ "$config_root" != /* || ! -d "$config_root" || -L "$config_root" ]]; then
  printf 'PETPACK_DATA_CONFIG_ROOT must be an existing real absolute directory.\n' >&2
  exit 1
fi
config_root="$(readlink -f -- "$config_root")"
export PETPACK_DATA_CONFIG_ROOT="$config_root"

app_password="$config_root/secrets/postgres_app_password"
postgres_ca="$config_root/runtime-tls/postgres/ca.crt"
redis_password="$config_root/secrets/redis_password"
redis_ca="$config_root/runtime-tls/redis/ca.crt"
for required_file in "$app_password" "$postgres_ca" "$redis_password" "$redis_ca"; do
  if [[ ! -f "$required_file" || -L "$required_file" ]]; then
    printf 'Required verification input is missing or unsafe: %s\n' "$required_file" >&2
    exit 1
  fi
done

expected_migration_count="$(find "$script_dir/../../../platform/sql" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
[[ "$expected_migration_count" =~ ^[1-9][0-9]*$ ]]

postgres_health="$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-postgres)"
redis_health="$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-redis)"
[[ "$postgres_health" == healthy ]]
[[ "$redis_health" == healthy ]]
expected_postgres_image_id="$(sudo docker image inspect --format='{{.Id}}' "$postgres_image")"
expected_redis_image_id="$(sudo docker image inspect --format='{{.Id}}' "$redis_image")"
[[ "$(sudo docker inspect --format='{{.Image}}' petpack-postgres)" == "$expected_postgres_image_id" ]]
[[ "$(sudo docker inspect --format='{{.Image}}' petpack-redis)" == "$expected_redis_image_id" ]]

if sudo ss -lnt | grep -Eq ':(5432|6379)[[:space:]]'; then
  printf 'A database port is unexpectedly published on the host.\n' >&2
  exit 1
fi

postgres_result="$(sudo docker run --rm \
  --network petpack-data \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=$app_password,dst=/run/secrets/postgres_app_password,readonly" \
  --mount "type=bind,src=$postgres_ca,dst=/run/tls/ca.crt,readonly" \
  "$postgres_image" bash -Eeuo pipefail -c '
    export PGPASSWORD="$(cat /run/secrets/postgres_app_password)"
    export PGSSLMODE=verify-full
    export PGSSLROOTCERT=/run/tls/ca.crt
    psql --host=postgres --username=petpack_app --dbname=petpack_studio \
      --tuples-only --no-align \
      --command="SELECT current_user || '\''|'\'' || (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) || '\''|'\'' || current_setting('\''ssl_min_protocol_version'\'') || '\''|'\'' || (SELECT count(*) FROM schema_migration) || '\''|'\'' || (SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\'');"
    unset PGPASSWORD
  ')"

IFS='|' read -r app_role tls_enabled tls_minimum migration_count table_count <<<"$postgres_result"
[[ "$app_role" == petpack_app ]]
[[ "$tls_enabled" == true ]]
[[ "$tls_minimum" == TLSv1.2 || "$tls_minimum" == TLSv1.3 ]]
[[ "$migration_count" == "$expected_migration_count" ]]
[[ "$table_count" =~ ^[1-9][0-9]*$ ]]

if sudo docker run --rm \
  --network petpack-data \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=$app_password,dst=/run/secrets/postgres_app_password,readonly" \
  "$postgres_image" bash -Eeuo pipefail -c '
    export PGPASSWORD="$(cat /run/secrets/postgres_app_password)"
    PGSSLMODE=disable psql --host=postgres --username=petpack_app --dbname=petpack_studio \
      --tuples-only --no-align --command="SELECT 1"
  ' >/dev/null 2>&1; then
  printf 'PostgreSQL unexpectedly accepted a plaintext connection.\n' >&2
  exit 1
fi

checksums="$(sudo docker exec -u postgres petpack-postgres psql \
  --username=petpack_admin --dbname=petpack_studio \
  --tuples-only --no-align --command='SHOW data_checksums;')"
[[ "$checksums" == on ]]
sudo docker exec petpack-postgres test ! -e /run/tls/ca.key
sudo docker exec petpack-redis test ! -e /run/tls/ca.key

redis_result="$(sudo docker exec petpack-redis bash -Eeuo pipefail -c '
  export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"
  redis-cli --tls --cacert /run/tls/ca.crt --user petpack -h redis ping
  unset REDISCLI_AUTH
')"
[[ "$redis_result" == PONG ]]

if sudo docker exec petpack-redis bash -Eeuo pipefail -c '
  export REDISCLI_AUTH="$(cat /run/secrets/redis_password)"
  redis-cli --user petpack -h 127.0.0.1 -p 6379 ping
' >/dev/null 2>&1; then
  printf 'Redis unexpectedly accepted a plaintext connection.\n' >&2
  exit 1
fi

latest_backup="$(sudo find /opt/petpack/shared/backups/postgres -maxdepth 1 \
  -type f -name 'petpack_studio-*.dump' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "$latest_backup" ]]
sudo test -s "$latest_backup"
sudo cat "$latest_backup" | \
  sudo docker exec -i -u postgres petpack-postgres pg_restore --list >/dev/null

grep -Fq '/usr/local/sbin/petpack-backup-postgres' /etc/cron.d/petpack-postgres-backup
[[ "$(sudo docker network inspect petpack-data --format='{{.Internal}}')" == true ]]

printf 'postgres=%s tls=%s tls_minimum=%s plaintext=blocked migrations=%s tables=%s checksums=%s\n' \
  "$postgres_health" "$tls_enabled" "$tls_minimum" "$migration_count" "$table_count" "$checksums"
printf 'redis=%s tls_auth=ok plaintext=blocked\n' "$redis_health"
printf 'host_ports=closed immutable_images=matched ca_private_keys=unmounted docker_network=internal backup=verified cron=installed\n'
