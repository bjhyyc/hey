#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

require_digest_image() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
    printf '%s must be an immutable repository@sha256 image reference.\n' "$label" >&2
    exit 1
  fi
}

config_root="${PETPACK_DATA_CONFIG_ROOT:-/opt/petpack/config/data}"
if [[ "$config_root" != /* || "$config_root" == / || "$config_root" == /opt || "$config_root" == /opt/petpack ]]; then
  printf 'PETPACK_DATA_CONFIG_ROOT must be a narrow absolute directory.\n' >&2
  exit 1
fi
if [[ -L "$config_root" ]]; then
  printf 'PETPACK_DATA_CONFIG_ROOT must not be a symbolic link.\n' >&2
  exit 1
fi
config_parent="$(dirname -- "$config_root")"
if ! sudo test -d "$config_parent" || sudo test -L "$config_parent"; then
  printf 'The parent of PETPACK_DATA_CONFIG_ROOT must be a pre-created real directory.\n' >&2
  exit 1
fi
if [[ "$(sudo readlink -f -- "$config_parent")" != "$config_parent" ]]; then
  printf 'The parent of PETPACK_DATA_CONFIG_ROOT must not traverse a symbolic link.\n' >&2
  exit 1
fi

require_digest_image "${PETPACK_POSTGRES_IMAGE:-}" PETPACK_POSTGRES_IMAGE
require_digest_image "${PETPACK_REDIS_IMAGE:-}" PETPACK_REDIS_IMAGE

sudo install -d -m 0700 \
  "$config_root" \
  "$config_root/secrets" \
  "$config_root/pki/postgres" \
  "$config_root/pki/redis" \
  "$config_root/runtime-tls/postgres" \
  "$config_root/runtime-tls/redis"
resolved_config_root="$(sudo readlink -f -- "$config_root")"
if [[ "$resolved_config_root" != "$config_root" ]]; then
  printf 'PETPACK_DATA_CONFIG_ROOT must not traverse a symbolic link.\n' >&2
  exit 1
fi
export PETPACK_DATA_CONFIG_ROOT="$resolved_config_root"

sudo install -d -m 0700 /opt/petpack/shared/backups/postgres
sudo install -d -m 0750 /opt/petpack/shared/logs
sudo sysctl -w vm.overcommit_memory=1 >/dev/null
sudo tee /etc/sysctl.d/90-petpack-redis.conf >/dev/null <<'EOF'
vm.overcommit_memory = 1
EOF

create_secret() {
  local target="$1"
  if ! sudo test -s "$target"; then
    local generated
    generated="$(openssl rand -hex 32)"
    printf '%s\n' "$generated" | sudo tee "$target" >/dev/null
    unset generated
  fi
  sudo chmod 0600 "$target"
  sudo chown root:root "$target"
}

create_secret "$PETPACK_DATA_CONFIG_ROOT/secrets/postgres_admin_password"
create_secret "$PETPACK_DATA_CONFIG_ROOT/secrets/postgres_app_password"
create_secret "$PETPACK_DATA_CONFIG_ROOT/secrets/redis_password"

assert_key_matches_certificate() {
  local key_path="$1"
  local cert_path="$2"
  local label="$3"
  local key_digest cert_digest
  key_digest="$(sudo openssl pkey -in "$key_path" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
  cert_digest="$(sudo openssl x509 -in "$cert_path" -pubkey -noout | \
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
  if [[ -z "$key_digest" || "$key_digest" != "$cert_digest" ]]; then
    printf '%s key and certificate do not match.\n' "$label" >&2
    exit 1
  fi
  if ! sudo openssl x509 -checkend 2592000 -noout -in "$cert_path"; then
    printf '%s certificate expires within 30 days.\n' "$label" >&2
    exit 1
  fi
}

ensure_authority() {
  local service="$1"
  local authority_dir="$PETPACK_DATA_CONFIG_ROOT/pki/$service"
  local key_path="$authority_dir/ca.key"
  local cert_path="$authority_dir/ca.crt"
  local has_key=0
  local has_cert=0
  sudo test -e "$key_path" && has_key=1
  sudo test -e "$cert_path" && has_cert=1
  if (( has_key != has_cert )); then
    printf 'Incomplete %s CA material; refusing to overwrite it.\n' "$service" >&2
    exit 1
  fi
  if (( has_key == 0 )); then
    sudo openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
      -subj "/CN=PetPack ${service} Internal CA" \
      -keyout "$key_path" -out "$cert_path"
  fi
  sudo chmod 0600 "$key_path"
  sudo chmod 0644 "$cert_path"
  sudo chown root:root "$key_path" "$cert_path"
  assert_key_matches_certificate "$key_path" "$cert_path" "$service CA"
}

cleanup_certificate_workspace() {
  local workspace="$1"
  if [[ "$workspace" != /tmp/petpack-cert.* || ! -d "$workspace" || -L "$workspace" ]]; then
    printf 'Refusing to clean an unexpected certificate workspace.\n' >&2
    return 1
  fi
  sudo rm -f -- \
    "$workspace/request.cnf" \
    "$workspace/server.csr" \
    "$workspace/server.key" \
    "$workspace/server.crt"
  rmdir -- "$workspace"
}

issue_server_certificate() {
  local service="$1"
  local authority_dir="$PETPACK_DATA_CONFIG_ROOT/pki/$service"
  local runtime_dir="$PETPACK_DATA_CONFIG_ROOT/runtime-tls/$service"
  local key_path="$runtime_dir/$service.key"
  local cert_path="$runtime_dir/$service.crt"
  local has_key=0
  local has_cert=0
  sudo test -e "$key_path" && has_key=1
  sudo test -e "$cert_path" && has_cert=1
  if (( has_key != has_cert )); then
    printf 'Incomplete %s server certificate; refusing to overwrite it.\n' "$service" >&2
    exit 1
  fi
  if (( has_key == 0 )); then
    local workspace
    workspace="$(mktemp -d /tmp/petpack-cert.XXXXXX)"
    cat > "$workspace/request.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $service
[v3]
subjectAltName = DNS:$service,DNS:localhost,IP:127.0.0.1
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
    openssl req -new -newkey rsa:3072 -sha256 -nodes \
      -config "$workspace/request.cnf" \
      -keyout "$workspace/server.key" \
      -out "$workspace/server.csr"
    sudo openssl x509 -req -sha256 -days 825 \
      -in "$workspace/server.csr" \
      -CA "$authority_dir/ca.crt" \
      -CAkey "$authority_dir/ca.key" \
      -CAcreateserial \
      -extfile "$workspace/request.cnf" \
      -extensions v3 \
      -out "$workspace/server.crt"
    sudo install -m 0600 "$workspace/server.key" "$key_path"
    sudo install -m 0644 "$workspace/server.crt" "$cert_path"
    cleanup_certificate_workspace "$workspace"
  fi
  sudo install -m 0644 "$authority_dir/ca.crt" "$runtime_dir/ca.crt"
  assert_key_matches_certificate "$key_path" "$cert_path" "$service server"
  sudo openssl verify -CAfile "$authority_dir/ca.crt" "$cert_path" >/dev/null
}

for service in postgres redis; do
  ensure_authority "$service"
  issue_server_certificate "$service"
done

sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$PETPACK_POSTGRES_IMAGE" \
  bash -Eeuo pipefail -c 'postgres --version | grep -Eq " 18\."; command -v psql pg_dump pg_restore >/dev/null'
sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$PETPACK_REDIS_IMAGE" \
  bash -Eeuo pipefail -c 'redis-server --version | grep -Eq "v=8\."; command -v redis-cli >/dev/null'

postgres_uid="$(sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$PETPACK_POSTGRES_IMAGE" id -u postgres)"
redis_uid="$(sudo docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$PETPACK_REDIS_IMAGE" id -u redis)"
[[ "$postgres_uid" =~ ^[0-9]+$ ]]
[[ "$redis_uid" =~ ^[0-9]+$ ]]

sudo chmod 0644 \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/postgres/ca.crt" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/postgres/postgres.crt" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/redis/ca.crt" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/redis/redis.crt"
sudo chmod 0600 \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/postgres/postgres.key" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/redis/redis.key"
sudo chown "$postgres_uid:$postgres_uid" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/postgres/postgres.key" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/postgres/postgres.crt"
sudo chown "$redis_uid:$redis_uid" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/redis/redis.key" \
  "$PETPACK_DATA_CONFIG_ROOT/runtime-tls/redis/redis.crt"

chmod +x initdb/00-runtime-role.sh redis/start-petpack-redis.sh \
  migrate-postgres.sh run-migrations.sh backup-postgres.sh bootstrap-data.sh verify-data.sh

sudo docker compose -f "$script_dir/compose.yaml" pull
sudo docker compose -f "$script_dir/compose.yaml" up -d

for _ in $(seq 1 36); do
  postgres_health="$(sudo docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' petpack-postgres 2>/dev/null || true)"
  redis_health="$(sudo docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' petpack-redis 2>/dev/null || true)"
  if [[ "$postgres_health" == healthy && "$redis_health" == healthy ]]; then
    break
  fi
  sleep 5
done

[[ "$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-postgres)" == healthy ]]
[[ "$(sudo docker inspect --format='{{.State.Health.Status}}' petpack-redis)" == healthy ]]

./migrate-postgres.sh "$script_dir/../../../platform/sql"

sudo install -m 0750 backup-postgres.sh /usr/local/sbin/petpack-backup-postgres
sudo tee /etc/cron.d/petpack-postgres-backup >/dev/null <<'EOF'
20 3 * * * root /usr/local/sbin/petpack-backup-postgres >>/opt/petpack/shared/logs/postgres-backup.log 2>&1
EOF
sudo chmod 0644 /etc/cron.d/petpack-postgres-backup

sudo /usr/local/sbin/petpack-backup-postgres --verify-restore
./verify-data.sh

printf '\nPetPack PostgreSQL and Redis are healthy.\n'
sudo docker compose -f "$script_dir/compose.yaml" ps
