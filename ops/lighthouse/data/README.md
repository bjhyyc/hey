# Lighthouse data services

This directory defines the private PostgreSQL and Redis data boundary for
PetPack Studio. Neither service publishes a host port. Application containers
join the internal `petpack-data` Docker network and connect to service names
`postgres:5432` and `redis:6379`.

## Release gate

Do not run `bootstrap-data.sh` on Lighthouse until a maintenance window and the
matching application CA handoff are prepared. The checked-in files are safe to
validate locally, but this rebuild has not changed the live data containers.

Two immutable image references are mandatory and must include the registry
digest, not only a tag:

```sh
export PETPACK_POSTGRES_IMAGE='registry/repository@sha256:<64 lowercase hex>'
export PETPACK_REDIS_IMAGE='registry/repository@sha256:<64 lowercase hex>'
export PETPACK_DATA_CONFIG_ROOT='/opt/petpack/config/data'
```

The operator must first create `/opt/petpack/config` as a real root-owned
directory. Bootstrap refuses a missing, symbolic-link or link-traversing parent
instead of creating an unverified path.

The exact digests must be selected only after the intended PostgreSQL 18 and
Redis release images have been pulled, scanned and exercised in staging. The
scripts deliberately refuse floating tags.

## Private configuration layout

`bootstrap-data.sh` creates the following operator-owned tree. It never stores
credentials or private keys in the Git release directory.

```text
/opt/petpack/config/data/
  secrets/
    postgres_admin_password
    postgres_app_password
    redis_password
  pki/
    postgres/ca.crt
    postgres/ca.key
    redis/ca.crt
    redis/ca.key
  runtime-tls/
    postgres/ca.crt
    postgres/postgres.crt
    postgres/postgres.key
    redis/ca.crt
    redis/redis.crt
    redis/redis.key
```

Only individual files below `runtime-tls` are mounted into the long-running
containers. The CA signing keys below `pki` are never mounted. PostgreSQL and
Redis have independent authorities and application CA files.

Before replacing an existing shared-CA deployment, copy the new PostgreSQL and
Redis public CA certificates into the corresponding application configuration,
then restart the data and application tiers in one controlled maintenance
window. Do not rotate a live server certificate independently of its clients.

## Enforced controls

- PostgreSQL loads the tracked `postgres/pg_hba.conf`; `hostnossl` is rejected
  before password authentication and `hostssl` requires SCRAM-SHA-256.
- PostgreSQL requires TLS 1.2 or newer. Its health check performs a real
  `verify-full` authenticated query rather than a plaintext `pg_isready` probe.
- Redis has `port 0`, exposes only its TLS port, disables the default user and
  restricts the application user to the configured `petpack:*` key/channel
  namespace. Administrative and destructive commands are denied.
- `verify-data.sh` proves both positive TLS connections and negative plaintext
  rejection for PostgreSQL and Redis, checks that no CA private key is mounted,
  and verifies that no database port is published on the host.
- Migrations run under one PostgreSQL advisory lock. Each numbered file remains
  a separate transaction, which is required for migration 013/014 enum changes;
  applied checksums are immutable.
- Daily PostgreSQL backups are serialized with a host lock, verified with
  `pg_restore --list`, restore-tested during bootstrap and retained for a
  bounded number of days under one validated backup directory.

## Safe validation and deployment order

1. Review the immutable image digests and scan evidence.
2. Prepare the external configuration tree and application CA handoff.
3. Parse without starting containers:

   ```sh
   docker compose -f ops/lighthouse/data/compose.yaml config --quiet
   ```

4. Run `bootstrap-data.sh` only in the approved maintenance window.
5. Run `verify-data.sh`; deployment fails unless plaintext is rejected and all
   positive TLS, migration, backup and internal-network checks pass.

The scripts never mount a disk root, `D:\桌宠`, or a project root into Docker.
Migration probes mount only the exact SQL directory, runner, password files and
public CA they need. Do not use `docker system prune`, `docker volume rm`, or a
recursive host cleanup as part of this procedure.
