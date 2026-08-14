import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Lighthouse data hardening contract", () => {
  it("requires immutable images and keeps both databases private", () => {
    const compose = read("ops/lighthouse/data/compose.yaml");
    expect(compose).toContain("PETPACK_POSTGRES_IMAGE:?Set PETPACK_POSTGRES_IMAGE to repository@sha256 digest");
    expect(compose).toContain("PETPACK_REDIS_IMAGE:?Set PETPACK_REDIS_IMAGE to repository@sha256 digest");
    expect(compose).not.toMatch(/^\s*image:\s*(postgres|redis):/m);
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).toContain("internal: true");
    expect(compose).not.toMatch(/host(_|-)network|network_mode:\s*host/i);
  });

  it("mounts only runtime TLS files and never mounts a CA signing key", () => {
    const compose = read("ops/lighthouse/data/compose.yaml");
    expect(compose).toContain("/runtime-tls/postgres/ca.crt:/run/tls/ca.crt:ro");
    expect(compose).toContain("/runtime-tls/postgres/postgres.key:/run/tls/postgres.key:ro");
    expect(compose).toContain("/runtime-tls/redis/ca.crt:/run/tls/ca.crt:ro");
    expect(compose).toContain("/runtime-tls/redis/redis.key:/run/tls/redis.key:ro");
    expect(compose).not.toContain("ca.key");
    expect(compose).not.toMatch(/\.\/secrets|\.\/tls/);
    expect(compose).toContain("PETPACK_DATA_CONFIG_ROOT:?Set absolute PETPACK_DATA_CONFIG_ROOT");
  });

  it("rejects PostgreSQL plaintext and verifies TLS in its health check", () => {
    const compose = read("ops/lighthouse/data/compose.yaml");
    const hba = read("ops/lighthouse/data/postgres/pg_hba.conf");
    expect(compose).toContain("ssl_min_protocol_version=TLSv1.2");
    expect(compose).toContain("hba_file=/etc/postgresql/petpack-pg_hba.conf");
    expect(compose).toContain("PGSSLMODE=verify-full");
    expect(compose).not.toContain("pg_isready");
    expect(hba.indexOf("hostnossl")).toBeLessThan(hba.indexOf("hostssl"));
    expect(hba.match(/^hostnossl\s+all\s+all\s+.*\s+reject$/gm)).toHaveLength(2);
    expect(hba.match(/^hostssl\s+all\s+all\s+.*\s+scram-sha-256$/gm)).toHaveLength(2);
  });

  it("separates signing PKI from runtime certificates and refuses floating tags", () => {
    const bootstrap = read("ops/lighthouse/data/bootstrap-data.sh");
    expect(bootstrap).toContain('"$config_root/pki/postgres"');
    expect(bootstrap).toContain('"$config_root/pki/redis"');
    expect(bootstrap).toContain('"$config_root/runtime-tls/postgres"');
    expect(bootstrap).toContain('"$config_root/runtime-tls/redis"');
    expect(bootstrap).toContain("@sha256:[a-f0-9]{64}");
    expect(bootstrap).toContain("--network none --read-only --cap-drop ALL");
    expect(bootstrap).toContain('postgres --version | grep -Eq " 18\\."');
    expect(bootstrap).toContain('redis-server --version | grep -Eq "v=8\\."');
    expect(bootstrap).toContain("assert_key_matches_certificate");
    expect(bootstrap).toContain("x509 -checkend 2592000");
    expect(bootstrap).toContain("openssl verify -CAfile");
    expect(bootstrap).not.toMatch(/rm\s+-rf|docker\s+(system\s+prune|volume\s+rm)/);
    expect(bootstrap).not.toMatch(/mount.*(?:[A-Z]:\\|\/mnt\/[a-z]|dst=\/host)/i);
  });

  it("serializes migrations in PostgreSQL and keeps each file transactional", () => {
    const runner = read("ops/lighthouse/data/run-migrations.sh");
    const launcher = read("ops/lighthouse/data/migrate-postgres.sh");
    expect(runner).toContain("SELECT pg_advisory_lock(731209871, 20260813)");
    expect(runner).toContain("SELECT pg_advisory_unlock(731209871, 20260813)");
    expect(runner).toContain("Applied migration checksum changed");
    expect(runner).toContain('PETPACK_MIGRATION_TEST_MODE:-0');
    expect(runner).toContain("\\getenv app_password PETPACK_MIGRATION_APP_PASSWORD");
    expect(runner).not.toContain("--set=app_password");
    expect(runner).toContain("BEGIN;");
    expect(runner).toContain("COMMIT;");
    expect(runner.match(/emit_migration_program \| psql/g)).toHaveLength(1);
    expect(launcher).toContain("--read-only");
    expect(launcher).toContain("--cap-drop ALL");
    expect(launcher).toContain("postgres_admin_password,readonly");
    expect(launcher).toContain("postgres_app_password,readonly");
    expect(launcher).not.toContain("/secrets:/run/secrets");
    expect(launcher).not.toContain("/tls:/run/tls");
  });

  it("proves negative plaintext paths and checks CA keys are absent", () => {
    const verify = read("ops/lighthouse/data/verify-data.sh");
    expect(verify).toContain("PGSSLMODE=disable");
    expect(verify).toContain("PostgreSQL unexpectedly accepted a plaintext connection");
    expect(verify).toContain("Redis unexpectedly accepted a plaintext connection");
    expect(verify.match(/test ! -e \/run\/tls\/ca\.key/g)).toHaveLength(2);
    expect(verify).toContain("expected_postgres_image_id");
    expect(verify).toContain("expected_redis_image_id");
    expect(verify).toContain("tls_minimum");
    expect(verify).not.toContain("curl -fsS");
  });

  it("keeps the local functional rehearsal inside the project D-drive temp tree", () => {
    const rehearsal = read("ops/lighthouse/data/run-local-tls-rehearsal.ps1");
    expect(rehearsal).toContain('".tmp\\data-tls-rehearsals"');
    expect(rehearsal).toContain("\\b18\\.");
    expect(rehearsal).toContain("PETPACK_MIGRATION_TEST_MODE");
    expect(rehearsal).toContain("Concurrent migrations failed");
    expect(rehearsal).toContain('PGSSLMODE = "disable"');
    expect(rehearsal).not.toMatch(/Remove-Item|docker\s+(system\s+prune|volume\s+rm)/i);

    const redisRehearsal = read("ops/lighthouse/data/run-local-redis-tls-rehearsal.ps1");
    expect(redisRehearsal).toContain('".tmp\\data-redis-tls-rehearsals"');
    expect(redisRehearsal).toContain('"--network", "none"');
    expect(redisRehearsal).toContain('"--read-only"');
    expect(redisRehearsal).toContain("Redis unexpectedly accepted plaintext");
    expect(redisRehearsal).toContain("Redis ACL accepted an out-of-prefix key");
    expect(redisRehearsal).toContain("Redis ACL accepted FLUSHALL");
    expect(redisRehearsal).not.toMatch(/docker\s+(system\s+prune|volume\s+rm|rm\b)/i);
  });

  it("bounds the Redis identity and backup cleanup scopes", () => {
    const redis = read("ops/lighthouse/data/redis/start-petpack-redis.sh");
    const redisConfig = read("ops/lighthouse/data/redis/redis.conf");
    const backup = read("ops/lighthouse/data/backup-postgres.sh");
    expect(redisConfig).toContain("port 0");
    expect(redisConfig).toContain("tls-port 6379");
    expect(redis).toContain("~%s:* &%s:*");
    for (const denied of ["-acl", "-flushall", "-flushdb", "-module", "-shutdown"]) {
      expect(redis).toContain(denied);
    }
    expect(backup).toContain("flock -n 9");
    expect(backup).toContain('readlink -f -- "$backup_dir"');
    expect(backup).toContain("-maxdepth 1");
    expect(backup).not.toContain("rm -rf");
  });
});
