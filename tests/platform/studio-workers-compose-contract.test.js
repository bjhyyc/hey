import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const compose = fs.readFileSync(
  path.join(root, "ops", "lighthouse", "app", "compose.studio-workers.yaml"),
  "utf8"
);

describe("private production Studio workers Compose contract", () => {
  it("is disabled by default and never publishes a host port", () => {
    expect(compose.match(/profiles: \["studio-production"\]/g)).toHaveLength(2);
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/host(_|-)network|network_mode:\s*host/i);
    expect(compose).not.toMatch(/[A-Z]:\\|\/mnt\/[a-z]\//i);
  });

  it("uses immutable-image inputs, external secrets, and separate Redis CA material", () => {
    expect(compose).toContain("PETPACK_RUNTIME_IMAGE:?Set PETPACK_RUNTIME_IMAGE to an immutable image digest");
    expect(compose).toContain("PETPACK_WORKER_IMAGE:?Set PETPACK_WORKER_IMAGE to an immutable image digest");
    expect(compose).toContain("PETPACK_CONFIG_ROOT:?Set PETPACK_CONFIG_ROOT");
    expect(compose).toContain("PETPACK_REDIS_CA_PEM_FILE: /run/secrets/redis_ca");
    expect(compose).not.toContain("PETPACK_REDIS_CA_PEM_FILE: /run/secrets/postgres_ca");
    expect(compose).not.toMatch(/\.\/secrets\//);
  });

  it("keeps the Worker private, non-root, read-only, bounded, and observable", () => {
    expect(compose).toContain('user: "10001:10001"');
    expect(compose.match(/read_only: true/g)).toHaveLength(2);
    expect(compose.match(/no-new-privileges:true/g)).toHaveLength(2);
    expect(compose.match(/cap_drop:/g)).toHaveLength(2);
    expect(compose).toContain("PETPACK_RUNTIME_HEARTBEAT_FILE: /run/petpack/worker-heartbeat.json");
    expect(compose).toContain('["CMD", "node", "src/runtime/check-runtime-heartbeat.js"]');
    expect(compose).toContain("petpack-worker-work:/work");
    expect(compose).toContain("PETPACK_WORKER_COMPONENTS_MODULE: ${PETPACK_WORKER_COMPONENTS_MODULE:?");
    expect(compose).toContain('command: ["src/runtime/start-outbox-dispatcher.js"]');
    expect(compose).not.toContain('command: ["node",');
  });

  it("does not attach the outbox dispatcher to the egress network", () => {
    const outbox = compose.slice(compose.indexOf("  outbox-dispatcher:"), compose.indexOf("  studio-worker:"));
    expect(outbox).toContain("- petpack-data");
    expect(outbox).not.toContain("petpack-egress");
  });
});
