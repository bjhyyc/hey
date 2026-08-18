# Studio workers deployment boundary

`compose.studio-workers.yaml` is the disabled-by-default production boundary for the full Studio API, outbox dispatcher, and media Worker. No service publishes a host port. The edge configuration exposes only the exact Kaipay V3 POST callback and the allowlisted Studio API surface; every non-provider route additionally requires the server-only internal bearer token.

## Current release gate

Do not start the `studio-production` profile yet. The production-assured component module now exists and the Worker image bundles its full delivery-validation layer, but the final deployment image still needs an SBOM/license/CVE rescan and the pinned manifest SHA-256 recorded from that exact image before a digest deployment replaces the controlled-real Worker.

The production image provides exactly `/app/platform/src/runtime/production-worker-components.js`; both Compose and the Worker reject any other module path, and the Worker fails closed if that module is absent, not marked production-assured, or its component manifest does not match `PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256`.

The Worker image additionally carries the delivery-validation layer:

- A pinned clean client tree at `/app/upstream-client` (`package.json`, `package-lock.json`, full `src`, plus its production `node_modules`); its tree SHA-256 is computed at build time by the interaction runner's own checksum routine.
- A pinned Electron `v31.7.7` linux-x64 runtime at `/app/electron` (zip SHA-256 verified against the published upstream checksum during the build) and the reviewed `xvfb` launcher wrapper at `/app/electron-headless`, which the interaction verifier pins by file checksum.
- Build-time pin files under `/app/pins` (client-tree/wrapper/runner checksums, frozen runner arguments and child environment); the runtime loads them through the `*_FILE` environment indirection.
- The Electron interaction runner requires a container init process for `xvfb-run`'s readiness signal — the Compose service already sets `init: true` — and `shm_size: "256m"` for Chromium's shared memory.

To obtain the manifest SHA-256 that must be pinned as `PETPACK_WORKER_COMPONENTS_MANIFEST_SHA256`, run the read-only helper inside the exact candidate image:

```sh
docker run --rm --init --network=none --read-only --tmpfs /tmp \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
  -e PETPACK_PLATFORM_MODE=production \
  "$PETPACK_WORKER_IMAGE" src/runtime/print-production-worker-manifest.js
```

Before any reviewed deployment, run `verify-studio-production.sh`. It is read-only: it checks the external secret files, immutable image digests, production/480p settings, component-module path, the pinned component-manifest SHA-256, and `docker compose ... config --quiet`; it never runs `up`, `down`, `pull`, `rm`, or `prune`.

The media image records the exact copied FFmpeg runtime files, source archive digest and license under `/app`. The Debian FFmpeg path is rejected at build time when it contains `libjxl0.7`. The pinned `ffmpeg-7.0.2-amd64-static` runtime has passed local VP9/green-screen normalization, but final publication still requires the release pipeline to reproduce the archive checksums, emit an SBOM, and review the GPL/codec license set for the enlarged image.

## Safety properties

- Images are supplied as immutable `repository@sha256:...` references.
- Secrets live below an absolute operator-owned `PETPACK_CONFIG_ROOT`; no release-relative `./secrets` directory is used.
- PostgreSQL and Redis use separate CA files.
- The Studio API joins edge, data and egress networks, but accepts non-provider routes only through the shared website gateway secret.
- The outbox dispatcher joins only the internal data network.
- The Worker joins the internal data network and a dedicated egress network, but never the public edge network.
- No service publishes a host port or mounts a host project directory.
- `/work` is a Docker named volume. `/tmp` and `/run/petpack` are bounded container tmpfs mounts.
- All three services run as `10001:10001`, with a read-only root filesystem, all capabilities dropped and `no-new-privileges` enabled.
- Health checks validate a fresh runtime heartbeat backed by live PostgreSQL and Redis/BullMQ probes; a merely running PID is not considered healthy.
- The read-only `npm run check:operations` command emits a bounded JSON snapshot of Outbox, durable executions, and BullMQ counts. It returns non-zero for an old ready Outbox row, dead execution, reconciliation-required execution, dead Outbox row, or failed queue job. It performs no queue mutation and does not start a Worker.

## Inputs to prepare later

Do not put any secret value in Git or chat. At the corresponding integration gate, write the secret values directly to the server files named by the Compose secret definitions and set only non-secret environment values in the deployment shell.

Required immutable image inputs:

- `PETPACK_RUNTIME_IMAGE`
- `PETPACK_WORKER_IMAGE`

Required private configuration root files:

- `postgres_url`
- `postgres_ca.pem`
- `redis_url`
- `redis_ca.pem`
- `cos_access_key_id`
- `cos_secret_access_key`
- `modelark_api_key`
- `session_signing_key`
- `studio_internal_token`
- `payment_notification_encryption_key`
- `kaipay_credentials_json`

Required non-secret production settings are visible as `${NAME:?message}` entries in `compose.studio-workers.yaml`. The canonical order and the exact information that will be requested from the user are fixed in `INTEGRATION_GATES.md`.

## Validation before any start

Run Compose parsing first with the profile enabled. Parsing must pass before creating or updating a container:

```sh
docker compose \
  -f ops/lighthouse/app/compose.studio-workers.yaml \
  --profile studio-production \
  config --quiet
```

Deployment must reference the final pushed image digests, not local tags. Never use `docker system prune`, `docker volume rm`, a disk-root bind mount, or a project-root bind mount in this workflow.

After the services are running, an operator may execute the same read-only check
inside the existing dispatcher container (it does not create a container or
change queue state):

```sh
docker exec petpack-outbox-dispatcher node src/runtime/check-operations-snapshot.js
```

The command exits non-zero only when one of the configured alert thresholds is
crossed. Thresholds are supplied as non-secret environment values, for example
`PETPACK_ALERT_OUTBOX_OLDEST_READY_SECONDS=60` and
`PETPACK_ALERT_QUEUE_FAILED_COUNT=0`.
