#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
migrations_dir="${1:-$script_dir/migrations}"

if [[ ! -d "$migrations_dir" ]]; then
  printf 'Migration directory not found: %s\n' "$migrations_dir" >&2
  exit 1
fi

sudo docker run --rm \
  --network petpack-data \
  --volume "$migrations_dir:/migrations:ro" \
  --volume "$script_dir/run-migrations.sh:/runner/run-migrations.sh:ro" \
  --volume "$script_dir/secrets:/run/secrets:ro" \
  --volume "$script_dir/tls/ca.crt:/run/tls/ca.crt:ro" \
  postgres:18.4-bookworm bash /runner/run-migrations.sh
