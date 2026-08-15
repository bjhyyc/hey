#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only release-set check. It does not connect to PostgreSQL and does not
# create or modify files. The migration runner remains responsible for applying
# each file under its advisory lock and recording the checksum in PostgreSQL.

migrations_dir="${1:-${BASH_SOURCE[0]%/*}/../../../platform/sql}"
required_last="015_kaipay_v3_order_identity.sql"

fail() {
  printf 'migration-release=%s\n' "$1" >&2
  exit 1
}

[[ -d "${migrations_dir}" && ! -L "${migrations_dir}" ]] || fail "directory_missing_or_symlink"
if ! resolved_dir="$(realpath -e -- "${migrations_dir}")"; then
  fail "directory_not_resolvable"
fi
migrations_dir="${resolved_dir}"

mapfile -t files < <(find "${migrations_dir}" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
(( ${#files[@]} >= 15 )) || fail "fewer_than_15_migrations"

expected=()
for number in $(seq 1 15); do
  ordinal="$(printf '%03d' "${number}")"
  expected+=("${ordinal}_")
done

for index in "${!expected[@]}"; do
  prefix="${expected[$index]}"
  matches=()
  for file in "${files[@]}"; do
    base="${file##*/}"
    [[ "${base}" == "${prefix}"* ]] && matches+=("${base}")
  done
  (( ${#matches[@]} == 1 )) || fail "migration_${prefix%_}_missing_or_ambiguous"
  file="${migrations_dir}/${matches[0]}"
  [[ -f "${file}" && ! -L "${file}" ]] || fail "migration_${matches[0]}_unsafe"
done

[[ -f "${migrations_dir}/${required_last}" && ! -L "${migrations_dir}/${required_last}" ]] || fail "kaipay_v3_migration_missing"

printf 'migration-release=ready count=%s latest=%s\n' "${#files[@]}" "${required_last}"
for file in "${files[@]}"; do
  sha256sum "${file}" | awk '{sub(/^\*/, "", $2); print $2 "|" $1}'
done
