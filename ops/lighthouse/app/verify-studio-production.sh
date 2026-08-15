#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only production gate. This script deliberately never starts, stops,
# removes, pulls, or prunes a container. It only proves that the operator's
# environment is complete enough for a separate, reviewed deployment step.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PETPACK_STUDIO_COMPOSE_FILE:-${SCRIPT_DIR}/compose.studio-workers.yaml}"

fail() {
  echo "studio-production-preflight=$1" >&2
  exit 1
}

[[ -f "${COMPOSE_FILE}" && ! -L "${COMPOSE_FILE}" ]] || fail "compose_file_missing"
[[ "${PETPACK_PLATFORM_MODE:-}" == "production" ]] || fail "PETPACK_PLATFORM_MODE_must_be_production"
[[ "${PETPACK_PHONE_AUTH_ENABLED:-}" == "true" ]] || fail "phone_auth_must_be_enabled"
[[ "${KAIPAY_ALLOW_SIMULATED_PAYMENTS:-false}" != "true" ]] || fail "simulated_payments_forbidden"
[[ "${MODELARK_VIDEO_RESOLUTION:-}" == "480p" ]] || fail "video_resolution_must_be_480p"
[[ "${PETPACK_RUNTIME_IMAGE:-}" == *@sha256:* ]] || fail "runtime_image_must_be_immutable_digest"
[[ "${PETPACK_WORKER_IMAGE:-}" == *@sha256:* ]] || fail "worker_image_must_be_immutable_digest"
required_components_module="/app/platform/src/runtime/production-worker-components.js"
components_module="${PETPACK_WORKER_COMPONENTS_MODULE:-${required_components_module}}"
[[ "${components_module}" == "${required_components_module}" ]] || fail "production_components_module_path_not_allowlisted"

CONFIG_ROOT="${PETPACK_CONFIG_ROOT:-}"
[[ -n "${CONFIG_ROOT}" && "${CONFIG_ROOT}" == /* ]] || fail "config_root_must_be_absolute"
CONFIG_ROOT="${CONFIG_ROOT%/}"
[[ "${CONFIG_ROOT}" != "/" && "${CONFIG_ROOT}" != "/opt" && "${CONFIG_ROOT}" != "/etc" ]] || fail "config_root_too_broad"
[[ -d "${CONFIG_ROOT}" && ! -L "${CONFIG_ROOT}" ]] || fail "config_root_missing_or_symlink"
CONFIG_REAL="$(realpath -e -- "${CONFIG_ROOT}" 2>/dev/null || true)"
[[ -n "${CONFIG_REAL}" && "${CONFIG_REAL}" == "${CONFIG_ROOT}" ]] || fail "config_root_path_changed_or_reparse"

required_secrets=(
  postgres_url
  postgres_ca.pem
  redis_url
  redis_ca.pem
  cos_access_key_id
  cos_secret_access_key
  modelark_api_key
  session_signing_key
  studio_internal_token
  payment_notification_encryption_key
  kaipay_credentials_json
)

for name in "${required_secrets[@]}"; do
  file="${CONFIG_ROOT}/${name}"
  [[ -f "${file}" && ! -L "${file}" ]] || fail "secret_missing:${name}"
  mode="$(stat -c '%a' "${file}")"
  [[ "${mode}" == "400" || "${mode}" == "600" ]] || fail "secret_permissions:${name}"
done

command -v docker >/dev/null 2>&1 || fail "docker_missing"
docker compose -f "${COMPOSE_FILE}" --profile studio-production config --quiet
echo "studio-production-preflight=ready"
