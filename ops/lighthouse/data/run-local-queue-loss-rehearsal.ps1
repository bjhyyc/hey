[CmdletBinding()]
param(
  [string]$RedisContainer = "petpack-rebuild-redis-20260813"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot "..\..\.."))
$expectedRepoRoot = "D:\PetPackStudio-Rebuild-20260813"
if (-not $repoRoot.Equals($expectedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Queue-loss rehearsal is pinned to $expectedRepoRoot"
}
$rehearsalBase = Join-Path $repoRoot ".tmp\queue-loss-rehearsals"
[System.IO.Directory]::CreateDirectory($rehearsalBase) | Out-Null
$baseInfo = Get-Item -LiteralPath $rehearsalBase -Force
if (($baseInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Queue-loss rehearsal base must not be a reparse point"
}
$runName = "queue-loss-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$runRoot = Join-Path $rehearsalBase $runName
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
if (-not $runRoot.StartsWith($rehearsalBase.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Queue-loss rehearsal escaped its approved D-drive directory"
}

$docker = (Get-Command docker -ErrorAction Stop).Source
$inspectionJson = & $docker inspect $RedisContainer
if ($LASTEXITCODE -ne 0) { throw "The isolated Redis rehearsal container is unavailable" }
$inspection = $inspectionJson | ConvertFrom-Json
if (@($inspection).Count -ne 1 -or $inspection[0].State.Status -ne "running") {
  throw "The isolated Redis rehearsal container must already be running"
}

$approvedMountRoot = Join-Path $repoRoot ".tmp\redis-rehearsal-20260813"
foreach ($mount in @($inspection[0].Mounts)) {
  $source = [System.IO.Path]::GetFullPath([string]$mount.Source)
  if (-not $source.StartsWith($approvedMountRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Redis rehearsal container has a mount outside its approved project temp directory"
  }
}
$binding = @($inspection[0].NetworkSettings.Ports.'6379/tcp')
if ($binding.Count -ne 1 -or $binding[0].HostIp -ne "127.0.0.1") {
  throw "Redis rehearsal must publish exactly one loopback-only port"
}
$redisPort = [int]$binding[0].HostPort
if ($redisPort -lt 1024 -or $redisPort -gt 65535) { throw "Redis rehearsal port is invalid" }

$command = @($inspection[0].Config.Cmd)
$passwordFlag = [Array]::IndexOf($command, "--requirepass")
if ($passwordFlag -lt 0 -or $passwordFlag + 1 -ge $command.Count) {
  throw "Redis rehearsal password configuration is unavailable"
}
$redisPassword = [string]$command[$passwordFlag + 1]
if ([string]::IsNullOrWhiteSpace($redisPassword)) { throw "Redis rehearsal password is empty" }
$caPath = Join-Path $approvedMountRoot "tls\ca.crt"
if (-not (Test-Path -LiteralPath $caPath -PathType Leaf)) { throw "Redis rehearsal CA is missing" }

$nodeScript = Join-Path $repoRoot "platform\src\development\verify-empty-redis-queue-recovery.js"
$seed = [guid]::NewGuid().ToString("N")
$encodedPassword = [uri]::EscapeDataString($redisPassword)
$env:NODE_ENV = "development"
$env:PETPACK_PLATFORM_MODE = "development"
$env:PETPACK_REDIS_URL = "rediss://default:${encodedPassword}@localhost:${redisPort}/15"
$env:PETPACK_REDIS_CA_PEM = Get-Content -LiteralPath $caPath -Raw
$env:PETPACK_REDIS_RECOVERY_SEED = $seed
$env:TEMP = $runRoot
$env:TMP = $runRoot

function Invoke-RecoveryPhase {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$QueueSuffix
  )
  $env:PETPACK_REDIS_RECOVERY_PHASE = $Phase
  $env:PETPACK_QUEUE_NAME = "petpack-loss-$QueueSuffix"
  $env:PETPACK_QUEUE_PREFIX = "petpack-loss-$QueueSuffix"
  $output = & node $nodeScript
  if ($LASTEXITCODE -ne 0) { throw "Queue-loss recovery phase failed: $Phase" }
  return ($output | Out-String).Trim() | ConvertFrom-Json
}

$source = Invoke-RecoveryPhase -Phase "source" -QueueSuffix "source-$($runName.Substring($runName.Length - 8))"
$recovered = Invoke-RecoveryPhase -Phase "recovered" -QueueSuffix "empty-$($runName.Substring($runName.Length - 8))"
if ($source.waitingBefore -ne 0 -or $source.waitingAfter -ne 1 -or
    $recovered.waitingBefore -ne 0 -or $recovered.waitingAfter -ne 1 -or
    $source.deterministicJobSha256 -ne $recovered.deterministicJobSha256) {
  throw "Queue-loss recovery evidence is inconsistent"
}

$report = [ordered]@{
  schemaVersion = "petpack-local-queue-loss-rehearsal/v1"
  runRoot = $runRoot
  redisContainer = $RedisContainer
  redisEndpoint = "localhost:$redisPort"
  simulation = "fresh-empty-queue-namespace"
  sourceWaitingBefore = [int]$source.waitingBefore
  sourceWaitingAfter = [int]$source.waitingAfter
  recoveredWaitingBefore = [int]$recovered.waitingBefore
  recoveredWaitingAfter = [int]$recovered.waitingAfter
  deterministicJobSha256 = [string]$recovered.deterministicJobSha256
  destructiveRedisCommandUsed = $false
  dockerMutationUsed = $false
  hostPathDeleted = $false
  retainedForAudit = $true
}
$reportPath = Join-Path $runRoot "report.json"
Write-Utf8NoBom -Path $reportPath -Content (($report | ConvertTo-Json -Depth 4) + "`n")
Write-Output "QUEUE_LOSS_REHEARSAL_OK=$reportPath"
