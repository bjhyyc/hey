#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${1:-$script_dir/../../../platform/sql}"
config_root="${PETPACK_DATA_CONFIG_ROOT:-/opt/petpack/config/data}"
postgres_image="${PETPACK_POSTGRES_IMAGE:-}"

if [[ ! "$postgres_image" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
  printf 'PETPACK_POSTGRES_IMAGE must be an immutable repository@sha256 image reference.\n' >&2
  exit 1
fi
if [[ "$config_root" != /* || ! -d "$config_root" || -L "$config_root" ]]; then
  printf 'PETPACK_DATA_CONFIG_ROOT must be an existing real absolute directory.\n' >&2
  exit 1
fi
config_root="$(readlink -f -- "$config_root")"

if [[ ! -d "$migrations_dir" || -L "$migrations_dir" ]]; then
  printf 'Migration directory not found or unsafe: %s\n' "$migrations_dir" >&2
  exit 1
fi
migrations_dir="$(cd -- "$migrations_dir" && pwd -P)"
if find "$migrations_dir" -maxdepth 1 -type l -name '*.sql' | grep -q .; then
  printf 'Migration directory contains a symbolic-link SQL file.\n' >&2
  exit 1
fi

admin_password="$config_root/secrets/postgres_admin_password"
app_password="$config_root/secrets/postgres_app_password"
postgres_ca="$config_root/runtime-tls/postgres/ca.crt"
for required_file in "$admin_password" "$app_password" "$postgres_ca"; do
  if [[ ! -f "$required_file" || -L "$required_file" ]]; then
    printf 'Required migration input is missing or unsafe: %s\n' "$required_file" >&2
    exit 1
  fi
done

sudo docker run --rm \
  --network petpack-data \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=$migrations_dir,dst=/migrations,readonly" \
  --mount "type=bind,src=$script_dir/run-migrations.sh,dst=/runner/run-migrations.sh,readonly" \
  --mount "type=bind,src=$admin_password,dst=/run/secrets/postgres_admin_password,readonly" \
  --mount "type=bind,src=$app_password,dst=/run/secrets/postgres_app_password,readonly" \
  --mount "type=bind,src=$postgres_ca,dst=/run/tls/ca.crt,readonly" \
  "$postgres_image" bash /runner/run-migrations.sh
