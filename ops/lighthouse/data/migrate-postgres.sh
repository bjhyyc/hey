#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${1:-$script_dir/../../../platform/sql}"

if [[ ! -d "$migrations_dir" ]]; then
  printf 'Migration directory not found: %s\n' "$migrations_dir" >&2
  exit 1
fi
migrations_dir="$(cd -- "$migrations_dir" && pwd -P)"
if find "$migrations_dir" -maxdepth 1 -type l -name '*.sql' | grep -q .; then
  printf 'Migration directory contains a symbolic-link SQL file.\n' >&2
  exit 1
fi

sudo docker run --rm \
  --network petpack-data \
  --volume "$migrations_dir:/migrations:ro" \
  --volume "$script_dir/run-migrations.sh:/runner/run-migrations.sh:ro" \
  --volume "$script_dir/secrets:/run/secrets:ro" \
  --volume "$script_dir/tls/ca.crt:/run/tls/ca.crt:ro" \
  postgres:18.4-bookworm bash /runner/run-migrations.sh
