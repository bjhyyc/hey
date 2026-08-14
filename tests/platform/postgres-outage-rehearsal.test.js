import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertApprovedControlRoot
} = require("../../platform/src/development/verify-postgres-outage-recovery");

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

describe("local PostgreSQL outage rehearsal safety", () => {
  it("accepts only retained control directories below the approved D-drive rehearsal base", () => {
    const base = path.join(repositoryRoot, ".tmp", "data-tls-rehearsals");
    const run = path.join(base, `unit-outage-${process.pid}-${Date.now()}`);
    const control = path.join(run, "control");
    fs.mkdirSync(control, { recursive: true });

    expect(assertApprovedControlRoot(control)).toBe(fs.realpathSync.native(control));
    expect(() => assertApprovedControlRoot(repositoryRoot)).toThrow(/escaped the approved rehearsal directory/);
  });

  it("uses exact isolated pg_ctl operations without Docker, volume, or path deletion commands", () => {
    const script = fs.readFileSync(
      path.join(repositoryRoot, "ops", "lighthouse", "data", "run-local-postgres-outage-rehearsal.ps1"),
      "utf8"
    );

    expect(script).toContain('.tmp\\data-tls-rehearsals');
    expect(script).toContain('Invoke-CheckedNative -FilePath $pgCtl -Arguments @("stop", "-D", $dataDir');
    expect(script).toContain('Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start", "-D", $dataDir');
    expect(script).toContain('Stop-OwnedChildProcess -Process $tlsProcess -Label "TLS rehearsal"');
    expect(script).toContain('Stop-OwnedChildProcess -Process $verifier -Label "PostgreSQL outage verifier"');
    expect(script).toContain("$Process.Kill($true)");
    expect(script).not.toMatch(/\b(?:docker|Remove-Item|Clear-Content)\b/i);
    expect(script).not.toMatch(/\brm\s+-/i);
    expect(script).not.toMatch(/\bStop-Process\b/i);
  });
});
