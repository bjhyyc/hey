#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

install -d -m 0700 secrets tls
install -d -m 0750 migrations
sudo install -d -m 0700 /opt/petpack/shared/backups/postgres
sudo sysctl -w vm.overcommit_memory=1 >/dev/null
sudo tee /etc/sysctl.d/90-petpack-redis.conf >/dev/null <<'EOF'
vm.overcommit_memory = 1
EOF

create_secret() {
  local target="$1"
  if [[ ! -s "$target" ]]; then
    umask 077
    openssl rand -hex 32 > "$target"
  fi
  chmod 0600 "$target"
}

create_secret secrets/postgres_admin_password
create_secret secrets/postgres_app_password
create_secret secrets/redis_password

if [[ ! -s tls/ca.key || ! -s tls/ca.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj '/CN=PetPack Internal Data CA' \
    -keyout tls/ca.key -out tls/ca.crt
fi

issue_server_certificate() {
  local service="$1"
  local config_file
  config_file="$(mktemp)"
  trap 'rm -f -- "$config_file"' RETURN
  cat > "$config_file" <<EOF
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
    -config "$config_file" -keyout "tls/$service.key" -out "tls/$service.csr"
  openssl x509 -req -sha256 -days 825 \
    -in "tls/$service.csr" -CA tls/ca.crt -CAkey tls/ca.key -CAcreateserial \
    -extfile "$config_file" -extensions v3 -out "tls/$service.crt"
  rm -f -- "tls/$service.csr" "$config_file"
  trap - RETURN
}

for service in postgres redis; do
  if [[ ! -s "tls/$service.key" || ! -s "tls/$service.crt" ]]; then
    issue_server_certificate "$service"
  fi
done

postgres_uid="$(sudo docker run --rm postgres:18.4-bookworm id -u postgres)"
redis_uid="$(sudo docker run --rm redis:8.2.7-bookworm id -u redis)"
sudo chmod 0644 tls/ca.crt tls/postgres.crt tls/redis.crt
sudo chmod 0600 tls/ca.key tls/postgres.key tls/redis.key
sudo chmod 0755 tls
sudo chown "$postgres_uid:$postgres_uid" tls/postgres.key tls/postgres.crt
sudo chown "$redis_uid:$redis_uid" tls/redis.key tls/redis.crt

chmod +x initdb/00-runtime-role.sh redis/start-petpack-redis.sh \
  migrate-postgres.sh run-migrations.sh backup-postgres.sh bootstrap-data.sh verify-data.sh

sudo docker compose pull
sudo docker compose up -d

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

./migrate-postgres.sh "$script_dir/migrations"

sudo install -m 0750 backup-postgres.sh /usr/local/sbin/petpack-backup-postgres
sudo tee /etc/cron.d/petpack-postgres-backup >/dev/null <<'EOF'
20 3 * * * root /usr/local/sbin/petpack-backup-postgres >>/opt/petpack/shared/logs/postgres-backup.log 2>&1
EOF
sudo chmod 0644 /etc/cron.d/petpack-postgres-backup

sudo /usr/local/sbin/petpack-backup-postgres --verify-restore
./verify-data.sh

printf '\nPetPack PostgreSQL and Redis are healthy.\n'
sudo docker compose ps
