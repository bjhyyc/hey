# Studio workers deployment boundary

`compose.studio-workers.yaml` is the disabled-by-default production boundary for the full Studio API, outbox dispatcher, and media Worker. No service publishes a host port. The edge configuration exposes only the exact Kaipay V3 POST callback and the allowlisted Studio API surface; every non-provider route additionally requires the server-only internal bearer token.

## Current release gate

Do not start the `studio-production` profile yet. The image and runtime isolation are implemented, but the production-assured source-photo, master-image, matting/QA and delivery-validator component module is still missing. `PETPACK_WORKER_COMPONENTS_MODULE` is deliberately required and the Worker fails closed if the module is absent or not marked production-assured.

The media image records the exact copied FFmpeg runtime files, Debian package versions and copyright notices under `/app`. Docker Scout reports no known vulnerability for the minimized image, but the manual package manifest still contains `libjxl0.7`; the previously reported unfixed jpeg-xl advisory remains an explicit launch blocker until FFmpeg is rebuilt with the minimum required codec/filter set or an equivalent patched runtime is verified.

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
- `modelark_callback_secret`
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
