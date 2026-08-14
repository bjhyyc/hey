[CmdletBinding()]
param(
  [string]$PostgresBin = "D:\PostgreSQL 15\bin",
  [string]$RedisContainer = "petpack-rebuild-redis-20260813"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
  }
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Get-LoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Stop-OwnedChildProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $Process.Refresh()
  if ($Process.HasExited) { return }
  $Process.Kill($true)
  if (-not $Process.WaitForExit(5000)) {
    throw "$Label did not exit after its owned process handle was terminated"
  }
}

$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot "..\..\.."))
$expectedRepoRoot = "D:\PetPackStudio-Rebuild-20260813"
if (-not $repoRoot.Equals($expectedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Hard-kill rehearsal is pinned to $expectedRepoRoot"
}
$rehearsalBase = Join-Path $repoRoot ".tmp\hard-kill-rehearsals"
[System.IO.Directory]::CreateDirectory($rehearsalBase) | Out-Null
$baseInfo = Get-Item -LiteralPath $rehearsalBase -Force
if (($baseInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Hard-kill rehearsal base must not be a reparse point"
}
$runName = "hard-kill-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$runRoot = Join-Path $rehearsalBase $runName
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
$expectedPrefix = $rehearsalBase.TrimEnd('\') + '\'
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Hard-kill rehearsal escaped the approved D-drive directory"
}
$runInfo = Get-Item -LiteralPath $runRoot -Force
if (($runInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Hard-kill rehearsal run root must not be a reparse point"
}

$postgres = Join-Path $PostgresBin "postgres.exe"
$initdb = Join-Path $PostgresBin "initdb.exe"
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$createdb = Join-Path $PostgresBin "createdb.exe"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeExe = $nodeCommand.Source
foreach ($required in @($postgres, $initdb, $pgCtl, $psql, $createdb, $nodeExe)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required executable is missing: $required" }
}
$versionText = (& $postgres --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '\b18\.') {
  throw "The hard-kill rehearsal requires PostgreSQL 18"
}

$postgresPort = Get-LoopbackPort
$apiPort = Get-LoopbackPort
$objectPort = Get-LoopbackPort
if (@($postgresPort, $apiPort, $objectPort) | Group-Object | Where-Object Count -gt 1) {
  throw "Hard-kill rehearsal loopback ports collided"
}
$dataDir = Join-Path $runRoot "postgres-data"
$postgresLog = Join-Path $runRoot "postgres.log"
$password = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$passwordFile = Join-Path $runRoot "postgres_password"
Write-Utf8NoBom -Path $passwordFile -Content ($password + "`n")

$dockerCommand = @(Get-Command docker -CommandType Application -ErrorAction Stop) |
  Where-Object { $_.Path -and $_.Path.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase) } |
  Select-Object -First 1
if (-not $dockerCommand -or -not (Test-Path -LiteralPath $dockerCommand.Path -PathType Leaf)) {
  throw "A unique Docker executable was not found"
}
$dockerExe = $dockerCommand.Path
$inspectionJson = & $dockerExe inspect $RedisContainer
if ($LASTEXITCODE -ne 0) { throw "The isolated Redis rehearsal container is unavailable" }
$inspection = $inspectionJson | ConvertFrom-Json
if (@($inspection).Count -ne 1 -or $inspection[0].State.Status -ne "running") {
  throw "The isolated Redis rehearsal container must already be running"
}
$approvedRedisMountRoot = Join-Path $repoRoot ".tmp\redis-rehearsal-20260813"
foreach ($mount in @($inspection[0].Mounts)) {
  $source = [System.IO.Path]::GetFullPath([string]$mount.Source)
  if (-not $source.StartsWith($approvedRedisMountRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Redis rehearsal container has a mount outside its approved project temp directory"
  }
}
$binding = @($inspection[0].NetworkSettings.Ports.'6379/tcp')
if ($binding.Count -ne 1 -or $binding[0].HostIp -ne "127.0.0.1") {
  throw "Redis rehearsal must publish exactly one loopback-only port"
}
$redisPort = [int]$binding[0].HostPort
$redisCommand = @($inspection[0].Config.Cmd)
$passwordFlag = [Array]::IndexOf($redisCommand, "--requirepass")
if ($passwordFlag -lt 0 -or $passwordFlag + 1 -ge $redisCommand.Count) {
  throw "Redis rehearsal password configuration is unavailable"
}
$redisPassword = [string]$redisCommand[$passwordFlag + 1]
$redisCaPath = Join-Path $approvedRedisMountRoot "tls\ca.crt"
if ([string]::IsNullOrWhiteSpace($redisPassword) -or -not (Test-Path -LiteralPath $redisCaPath -PathType Leaf)) {
  throw "Redis rehearsal credentials are incomplete"
}

$serverStarted = $false
$harness = $null
try {
  Invoke-CheckedNative -FilePath $initdb -Arguments @(
    "-D", $dataDir, "-U", "petpack_app", "--pwfile=$passwordFile",
    "--auth-host=scram-sha-256", "--auth-local=trust", "--data-checksums", "--no-locale", "--encoding=UTF8"
  )
  $postgresConfig = Join-Path $dataDir "postgresql.conf"
  [System.IO.File]::AppendAllText($postgresConfig, @"

listen_addresses = '127.0.0.1'
port = $postgresPort
password_encryption = 'scram-sha-256'
"@, [System.Text.UTF8Encoding]::new($false))
  Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start", "-D", $dataDir, "-l", $postgresLog, "-w", "-t", "30")
  $serverStarted = $true

  $env:PGPASSWORD = $password
  Invoke-CheckedNative -FilePath $createdb -Arguments @(
    "--host=127.0.0.1", "--port=$postgresPort", "--username=petpack_app", "petpack_studio"
  )
  $migrationLog = Join-Path $runRoot "migrations.log"
  foreach ($migration in Get-ChildItem -LiteralPath (Join-Path $repoRoot "platform\sql") -Filter "*.sql" -File | Sort-Object Name) {
    $migrationFileArgument = "--file=$($migration.FullName)"
    $migrationOutput = (& $psql --host=127.0.0.1 --port=$postgresPort --username=petpack_app --dbname=petpack_studio `
      --set=ON_ERROR_STOP=1 --single-transaction $migrationFileArgument 2>&1 | Out-String)
    [System.IO.File]::AppendAllText($migrationLog, "[$($migration.Name)]`n$migrationOutput", [System.Text.UTF8Encoding]::new($false))
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($migration.Name); inspect $migrationLog" }
  }

  $encodedPostgresPassword = [System.Uri]::EscapeDataString($password)
  $encodedRedisPassword = [System.Uri]::EscapeDataString($redisPassword)
  $env:NODE_ENV = "development"
  $env:PETPACK_PLATFORM_MODE = "development"
  $env:PETPACK_POSTGRES_URL = "postgresql://petpack_app:${encodedPostgresPassword}@127.0.0.1:${postgresPort}/petpack_studio"
  $env:PETPACK_REDIS_URL = "rediss://default:${encodedRedisPassword}@127.0.0.1:${redisPort}/15"
  $env:PETPACK_REDIS_CA_PEM = Get-Content -LiteralPath $redisCaPath -Raw
  $env:PETPACK_REHEARSAL_API_PORT = [string]$apiPort
  $env:PETPACK_REHEARSAL_OBJECT_PORT = [string]$objectPort
  $env:PETPACK_REHEARSAL_HARD_KILL_ALL = "true"
  $env:TEMP = $runRoot
  $env:TMP = $runRoot
  $stdoutPath = Join-Path $runRoot "harness.stdout.log"
  $stderrPath = Join-Path $runRoot "harness.stderr.log"
  $harnessEntry = Join-Path $repoRoot "platform\src\development\run-zero-cost-rehearsal.js"
  $harness = Start-Process -FilePath $nodeExe -ArgumentList @($harnessEntry) -WorkingDirectory $repoRoot `
    -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  if (-not $harness.WaitForExit(360000)) {
    Stop-OwnedChildProcess -Process $harness -Label "Hard-kill rehearsal harness"
    throw "Hard-kill rehearsal timed out; inspect retained logs under $runRoot"
  }
  $harness.Refresh()
  if ($harness.ExitCode -ne 0) { throw "Hard-kill rehearsal failed; inspect retained logs under $runRoot" }
  $resultLine = @(Get-Content -LiteralPath $stdoutPath | Where-Object { $_ -match '^\{"ok":true,' })[-1]
  if (-not $resultLine) { throw "Hard-kill rehearsal did not return its final report" }
  $result = $resultLine | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath ([string]$result.reportPath) -PathType Leaf)) {
    throw "Hard-kill rehearsal report path is missing"
  }
  $report = [ordered]@{
    schemaVersion = "petpack-local-hard-kill-rehearsal/v1"
    runRoot = $runRoot
    workflowReport = [string]$result.reportPath
    postgresVersion = $versionText
    postgresPort = $postgresPort
    redisContainer = $RedisContainer
    redisPort = $redisPort
    apiHardKilled = [bool]$result.faultInjection.apiHardKilled
    outboxHardKilled = [bool]$result.faultInjection.outboxHardKilled
    workerHardKilled = [bool]$result.faultInjection.workerHardKilled
    externalProviderCallCount = [int]$result.externalCallCount
    exactOwnedChildHandlesOnly = $true
    dockerMutationUsed = $false
    destructiveRedisCommandUsed = $false
    hostPathDeleted = $false
    retainedForAudit = $true
  }
  if (-not $report.apiHardKilled -or -not $report.outboxHardKilled -or -not $report.workerHardKilled -or
      $report.externalProviderCallCount -ne 0) {
    throw "Hard-kill rehearsal result is incomplete"
  }
  $reportPath = Join-Path $runRoot "report.json"
  Write-Utf8NoBom -Path $reportPath -Content (($report | ConvertTo-Json -Depth 6) + "`n")
  Write-Output "HARD_KILL_REHEARSAL_OK=$reportPath"
} finally {
  if ($harness -and -not $harness.HasExited) {
    try { Stop-OwnedChildProcess -Process $harness -Label "Hard-kill rehearsal harness" } catch {
      Write-Warning "The owned hard-kill harness did not stop cleanly; inspect $runRoot"
    }
  }
  if ($serverStarted) {
    & $pgCtl stop -D $dataDir -m fast -w -t 30 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "The isolated PostgreSQL process did not stop cleanly; inspect $runRoot" }
  }
  foreach ($name in @(
    "PGPASSWORD", "PETPACK_POSTGRES_URL", "PETPACK_REDIS_URL", "PETPACK_REDIS_CA_PEM",
    "PETPACK_REHEARSAL_API_PORT", "PETPACK_REHEARSAL_OBJECT_PORT", "PETPACK_REHEARSAL_HARD_KILL_ALL"
  )) {
    [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
}
