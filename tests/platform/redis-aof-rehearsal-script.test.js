import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(root, "ops", "lighthouse", "data", "run-local-redis-aof-rehearsal.ps1");
const script = fs.readFileSync(scriptPath, "utf8");

describe("local Redis AOF restart rehearsal script", () => {
  it("creates a unique digest-pinned TLS-only AOF container with only run-root binds", () => {
    expect(script).toMatch(/^#requires -Version 7\.2/);
    expect(script).toContain('$projectTmpRoot = Join-Path $repoRoot ".tmp"');
    expect(script).toContain('$rehearsalBase = Join-Path $projectTmpRoot "redis-aof-rehearsals"');
    expect(script).toContain('$expectedRepoRoot = "D:\\PetPackStudio-Rebuild-20260813"');
    expect(script).toContain('"create", "--pull", "never", "--name", $containerName');
    expect(script).toContain('$redisPort = Get-LoopbackPort');
    expect(script).toContain('"--restart", "no", "--network", "bridge", "--publish", "127.0.0.1:${redisPort}:6379"');
    expect(script).toContain('[Parameter(Mandatory = $true)][int]$ExpectedHostPort');
    expect(script).toContain('[string]$portBindings[0].HostPort -ne [string]$ExpectedHostPort');
    expect(script).toContain('"--read-only", "--user", "redis", "--cap-drop", "ALL"');
    expect(script).toContain('"--mount", "type=bind,src=$dataRoot,dst=/data"');
    expect(script).toContain("appendonly yes");
    expect(script).toContain("appendfsync everysec");
    expect(script).toContain("aof-load-truncated no");
    expect(script).toContain('save ""');
    expect(script).toContain('~petpack-*:* &petpack-*:*');
    expect(script).toContain("GetRelativePath($volumeRoot, $absolute)");
    expect(script).toContain('Assert-NoReparseChain -Path $scriptRoot -Base $repoRoot');
    expect(script).toContain('Assert-NoReparseChain -Path $projectTmpRoot -Base $repoRoot');
    expect(script).toContain("Assert-NoReparseChain -Path ([string]$mount.Source) -Base $RunRoot");
    expect(script).toContain("$tmpfsConfig = $inspection.HostConfig.Tmpfs");
    expect(script).toContain('$bindMounts = @($mounts | Where-Object { [string]$_.Type -eq "bind" })');
    expect(script).toContain('[string]$representedTmpfs[0].Destination -ne "/tmp"');
    expect(script).toContain("-WindowStyle Hidden -PassThru");
  });

  it("mutates Docker only by the full captured container ID and retains it stopped", () => {
    expect(script).toContain("$ContainerId -notmatch '^[a-f0-9]{64}$'");
    expect(script).toContain('Invoke-CheckedNative -FilePath $docker -Arguments @("stop", "--time", "10", $containerId)');
    expect(script).toContain('Invoke-CheckedNative -FilePath $docker -Arguments @("start", $containerId)');
    expect(script).toContain('-ExpectedState "exited"');
    expect(script).toContain('sameContainerRestarted = $true');
    expect(script).not.toContain("petpack-rebuild-redis-20260813");
    expect(script).not.toMatch(/--rm\b/i);
    expect(script).not.toMatch(/\bdocker\s+(?:rm|container\s+rm|system\s+prune|volume\s+rm|network\s+rm)\b/i);
  });

  it("has no host deletion, broad process kill, or destructive Redis invocation", () => {
    expect(script).not.toMatch(/\b(?:Remove-Item|Clear-Content|rmdir|erase|del|Stop-Process|taskkill)\b/i);
    expect(script).not.toMatch(/\brm\s+-/i);
    const destructiveMentions = script.split(/\r?\n/).filter((line) => /flushall|flushdb/i.test(line));
    expect(destructiveMentions).toHaveLength(1);
    expect(destructiveMentions[0]).toMatch(/-flushall\s+-flushdb/i);
    expect(script).not.toMatch(/redis-cli[^\r\n]*(?:flushall|flushdb)/i);
    expect(script).not.toMatch(/Invoke-RedisTls[^\r\n]*-Command[^\r\n]*(?:flushall|flushdb)/i);
  });

  it("blocks the forbidden drive and uses nonce-bound exclusive checkpoint files", () => {
    expect(script).toContain('$root.Equals("E:\\", [System.StringComparison]::OrdinalIgnoreCase)');
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain('schemaVersion = "petpack-redis-aof-resume/v1"');
    expect(script).toContain('nonce = [string]$ready.nonce');
    expect(script).toContain('containerId = $containerId');
    expect(script).toContain('PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT = $controlRoot');
    expect(script).toContain("Wait-ForJsonEvidenceFile -Path $readyPath -Base $controlRoot");
    expect(script).toContain("ConvertFrom-Json -ErrorAction Stop");
    expect(script).toContain('if ((Get-RedisHostPort -Inspection $runningInspection) -ne $redisPort)');
    expect(script.indexOf("$redisPort = Get-LoopbackPort")).toBeLessThan(script.indexOf("$createArguments = @("));
    expect(script.indexOf("$redisPort = Get-LoopbackPort")).toBeLessThan(script.indexOf("$candidatePorts = @("));
  });

  it("validates the complete zero-cost and queue-drain contract before reporting success", () => {
    for (const expected of [
      "sourcePhotos -ne 3",
      "passedMasters -ne 3",
      "passedActions -ne 7",
      "passedQaReports -ne 12",
      "totalExecutions -ne 38",
      "succeededExecutions -ne 38",
      "totalOutboxJobs -ne 39",
      "sentOutboxJobs -ne 39",
      "fixtureUsageAttempts -ne 10",
      "finalQueue.counts.completed -ne 39",
      "finalQueue.counts.prioritized -ne 0",
      "finalQueue.counts.'waiting-children' -ne 0",
      "finalQueue.counts.repeat -ne 0"
    ]) expect(script).toContain(expected);
    expect(script).toContain('Write-Output "REDIS_AOF_REHEARSAL_OK=$reportPath"');
  });

  it("starts PostgreSQL through one bounded pg_ctl process handle without a PowerShell output pipe", () => {
    expect(script).toContain("$postgresStartProcess = Start-Process -FilePath $pgCtl");
    expect(script).toContain("$postgresStartProcess.WaitForExit(30000)");
    expect(script).toContain("$postgresStartProcess.Kill($true)");
    expect(script).toContain("-RedirectStandardOutput $postgresStartStdout");
    expect(script).toContain("-RedirectStandardError $postgresStartStderr");
    expect(script).not.toContain('Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start"');
    expect(script).not.toContain("& $pgCtl start -D $postgresData");
  });
});
