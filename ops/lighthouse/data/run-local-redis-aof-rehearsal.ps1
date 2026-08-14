#requires -Version 7.2

[CmdletBinding()]
param(
  [string]$PostgresBin = "D:\PostgreSQL 15\bin",
  [string]$RedisImage = "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb",
  [string]$OpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
  }
  return @($output)
}

function Write-Utf8NoBomExclusive {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Content)
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Assert-NotForbiddenDrive {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $absolute = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($absolute)
  if ($root -and $root.Equals("E:\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must never target the forbidden E drive"
  }
  return $absolute
}

function Assert-StrictDescendant {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $absolute = Assert-NotForbiddenDrive -Path $Path -Label $Label
  $absoluteBase = Assert-NotForbiddenDrive -Path $Base -Label "$Label base"
  $prefix = $absoluteBase.TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its approved directory"
  }
  return $absolute
}

function Assert-NoReparseChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $absolute = Assert-StrictDescendant -Path $Path -Base $Base -Label $Label
  $volumeRoot = [System.IO.Path]::GetPathRoot($absolute)
  if ([string]::IsNullOrWhiteSpace($volumeRoot)) { throw "$Label has no filesystem root" }
  $relative = [System.IO.Path]::GetRelativePath($volumeRoot, $absolute)
  $candidates = @($volumeRoot)
  $current = $volumeRoot
  foreach ($segment in $relative.Split([System.IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $segment
    $candidates += $current
  }
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { break }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not traverse a link or reparse point"
    }
    $real = [System.IO.Path]::GetFullPath($item.FullName)
    if (-not $real.Equals([System.IO.Path]::GetFullPath($candidate), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label resolved through an unexpected filesystem path"
    }
  }
  return $absolute
}

function Get-LoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
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
    throw "$Label did not exit after its exact owned process handle was terminated"
  }
}

function Wait-ForJsonEvidenceFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 300
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $evidencePath = Assert-NoReparseChain -Path $Path -Base $Base -Label "Redis AOF checkpoint evidence"
      try {
        $parsed = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $parsed) { return $parsed }
      } catch {
        # The producer opens the file exclusively before writing it. Retry only
        # the bounded partial-write window while its exact process is alive.
      }
    }
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Zero-cost harness exited before writing its Redis AOF checkpoint"
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for Redis AOF checkpoint evidence"
}

function Get-ContainerInspection {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId
  )
  if ($ContainerId -notmatch '^[a-f0-9]{64}$') { throw "Owned Redis container ID is invalid" }
  $json = Invoke-CheckedNative -FilePath $Docker -Arguments @("inspect", $ContainerId)
  $inspection = ($json | Out-String) | ConvertFrom-Json
  if (@($inspection).Count -ne 1 -or [string]$inspection[0].Id -ne $ContainerId) {
    throw "Docker did not return the exact owned Redis container"
  }
  return $inspection[0]
}

function Assert-OwnedRedisContainer {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId,
    [Parameter(Mandatory = $true)][string]$ContainerName,
    [Parameter(Mandatory = $true)][string]$Nonce,
    [Parameter(Mandatory = $true)][string]$ImageId,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][hashtable]$ExpectedMounts,
    [Parameter(Mandatory = $true)][int]$ExpectedHostPort,
    [string]$ExpectedState = ""
  )
  $inspection = Get-ContainerInspection -Docker $Docker -ContainerId $ContainerId
  if ([string]$inspection.Name -ne "/$ContainerName" -or
      [string]$inspection.Config.Labels.'petpack.rehearsal.kind' -ne "redis-aof" -or
      [string]$inspection.Config.Labels.'petpack.rehearsal.nonce' -ne $Nonce -or
      [string]$inspection.Image -ne $ImageId) {
    throw "Owned Redis container identity changed"
  }
  if ($ExpectedState -and [string]$inspection.State.Status -ne $ExpectedState) {
    throw "Owned Redis container state is not $ExpectedState"
  }
  if ([string]$inspection.HostConfig.RestartPolicy.Name -ne "no" -or
      [string]$inspection.HostConfig.NetworkMode -ne "bridge" -or
      $inspection.HostConfig.ReadonlyRootfs -ne $true -or
      [string]$inspection.Config.User -ne "redis") {
    throw "Owned Redis container runtime isolation changed"
  }
  if (-not (@($inspection.HostConfig.CapDrop) -contains "ALL") -or
      -not (@($inspection.HostConfig.SecurityOpt) | Where-Object { ([string]$_).StartsWith("no-new-privileges") })) {
    throw "Owned Redis container privilege restrictions changed"
  }
  $portBindings = @($inspection.HostConfig.PortBindings.'6379/tcp')
  if ($portBindings.Count -ne 1 -or [string]$portBindings[0].HostIp -ne "127.0.0.1" -or
      [string]$portBindings[0].HostPort -ne [string]$ExpectedHostPort) {
    throw "Owned Redis container must retain its exact dedicated loopback binding"
  }
  $tmpfsConfig = $inspection.HostConfig.Tmpfs
  if (-not $tmpfsConfig) { throw "Owned Redis container tmpfs configuration is missing" }
  $tmpfsProperties = @($tmpfsConfig.PSObject.Properties)
  $expectedTmpfsOptions = (@("rw", "noexec", "nosuid", "nodev", "size=8m") | Sort-Object) -join ","
  if ($tmpfsProperties.Count -ne 1 -or [string]$tmpfsProperties[0].Name -ne "/tmp" -or
      ((@(([string]$tmpfsProperties[0].Value).Split(",") | Where-Object { $_ }) | Sort-Object) -join ",") -ne $expectedTmpfsOptions) {
    throw "Owned Redis container must have exactly the approved /tmp tmpfs"
  }
  $mounts = @($inspection.Mounts)
  $bindMounts = @($mounts | Where-Object { [string]$_.Type -eq "bind" })
  $representedTmpfs = @($mounts | Where-Object { [string]$_.Type -ne "bind" })
  if ($bindMounts.Count -ne $ExpectedMounts.Count -or $representedTmpfs.Count -gt 1 -or
      ($representedTmpfs.Count -eq 1 -and
        ([string]$representedTmpfs[0].Type -ne "tmpfs" -or
         [string]$representedTmpfs[0].Destination -ne "/tmp" -or [bool]$representedTmpfs[0].RW -ne $true))) {
    throw "Owned Redis container mount inventory changed"
  }
  foreach ($mount in $bindMounts) {
    $destination = [string]$mount.Destination
    if (-not $ExpectedMounts.ContainsKey($destination)) { throw "Owned Redis container has an unexpected mount target" }
    $expected = $ExpectedMounts[$destination]
    $source = Assert-NoReparseChain -Path ([string]$mount.Source) -Base $RunRoot -Label "Redis bind source"
    if (-not $source.Equals([string]$expected.Source, [System.StringComparison]::OrdinalIgnoreCase) -or
        [bool]$mount.RW -ne [bool]$expected.ReadWrite) {
      throw "Owned Redis container bind source or access mode changed"
    }
  }
  return $inspection
}

function Get-RedisHostPort {
  param([Parameter(Mandatory = $true)]$Inspection)
  $bindings = @($Inspection.NetworkSettings.Ports.'6379/tcp')
  if ($bindings.Count -ne 1 -or [string]$bindings[0].HostIp -ne "127.0.0.1") {
    throw "Owned Redis container does not expose exactly one loopback port"
  }
  $port = 0
  if (-not [int]::TryParse([string]$bindings[0].HostPort, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
    throw "Owned Redis loopback port is invalid"
  }
  return $port
}

function Wait-RedisTlsReady {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId,
    [Parameter(Mandatory = $true)][string]$Password
  )
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $pong = & $Docker exec --env "REDISCLI_AUTH=$Password" $ContainerId redis-cli --raw `
      --tls --cacert /run/tls/ca.crt --user petpack -h 127.0.0.1 ping 2>$null
    if ($LASTEXITCODE -eq 0 -and ($pong | Out-String).Trim() -eq "PONG") { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Owned Redis TLS readiness probe failed"
}

function Invoke-RedisTls {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string[]]$Command
  )
  $arguments = @(
    "exec", "--env", "REDISCLI_AUTH=$Password", $ContainerId,
    "redis-cli", "--raw", "--tls", "--cacert", "/run/tls/ca.crt",
    "--user", "petpack", "-h", "127.0.0.1"
  )
  $arguments += $Command
  return Invoke-CheckedNative -FilePath $Docker -Arguments $arguments
}

function Get-RedisPersistenceEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId,
    [Parameter(Mandatory = $true)][string]$Password
  )
  $lines = Invoke-RedisTls -Docker $Docker -ContainerId $ContainerId -Password $Password -Command @("INFO", "persistence")
  $values = @{}
  foreach ($line in $lines) {
    $text = [string]$line
    if ($text -match '^([^:#]+):(.+)$') { $values[$matches[1]] = $matches[2].Trim() }
  }
  $currentSize = 0L
  if ($values['aof_enabled'] -ne "1" -or $values['aof_last_write_status'] -ne "ok" -or
      $values['aof_last_bgrewrite_status'] -ne "ok" -or
      -not [long]::TryParse([string]$values['aof_current_size'], [ref]$currentSize) -or $currentSize -lt 1) {
    throw "Owned Redis persistence evidence is incomplete"
  }
  return [ordered]@{
    aofEnabled = $true
    currentSize = $currentSize
    lastWriteStatus = [string]$values['aof_last_write_status']
    lastRewriteStatus = [string]$values['aof_last_bgrewrite_status']
  }
}

function Assert-RedisPlaintextRejected {
  param(
    [Parameter(Mandatory = $true)][string]$Docker,
    [Parameter(Mandatory = $true)][string]$ContainerId,
    [Parameter(Mandatory = $true)][string]$Password
  )
  & $Docker exec --env "REDISCLI_AUTH=$Password" $ContainerId redis-cli --raw `
    --user petpack -h 127.0.0.1 -p 6379 ping 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) { throw "Owned Redis unexpectedly accepted plaintext" }
}

function Get-AofFileEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$RunRoot
  )
  $aofRoot = Assert-NoReparseChain -Path (Join-Path $DataRoot "appendonlydir") -Base $RunRoot -Label "Redis AOF directory"
  $manifestPath = Assert-NoReparseChain -Path (Join-Path $aofRoot "appendonly.aof.manifest") -Base $RunRoot -Label "Redis AOF manifest"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Redis AOF manifest is missing" }
  $manifestInfo = Get-Item -LiteralPath $manifestPath -Force
  if (($manifestInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Redis AOF manifest must not be a link"
  }
  $files = @()
  foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if ($line -notmatch '^file ([A-Za-z0-9._-]+) seq ([0-9]+) type ([bi])(?: .*)?$') {
      throw "Redis AOF manifest contains an unsafe entry"
    }
    $name = $matches[1]
    $filePath = Assert-NoReparseChain -Path (Join-Path $aofRoot $name) -Base $RunRoot -Label "Redis AOF segment"
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "Redis AOF segment is missing" }
    $info = Get-Item -LiteralPath $filePath -Force
    if (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -lt 1) {
      throw "Redis AOF segment is invalid"
    }
    $files += [ordered]@{
      name = $name
      byteSize = [long]$info.Length
      sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  if ($files.Count -lt 1) { throw "Redis AOF manifest has no data segments" }
  if (Test-Path -LiteralPath (Join-Path $DataRoot "dump.rdb")) {
    throw "Redis AOF rehearsal unexpectedly produced a standalone RDB snapshot"
  }
  return [ordered]@{
    manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    segments = $files
  }
}

if ($RedisImage -notmatch '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$') {
  throw "RedisImage must be an immutable repository@sha256 reference"
}

$scriptRoot = Assert-NotForbiddenDrive -Path $PSScriptRoot -Label "Script root"
$repoRoot = Assert-NotForbiddenDrive -Path (Join-Path $scriptRoot "..\..\..") -Label "Repository root"
$expectedRepoRoot = "D:\PetPackStudio-Rebuild-20260813"
if (-not $repoRoot.Equals($expectedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Redis AOF rehearsal is pinned to $expectedRepoRoot"
}
Assert-NoReparseChain -Path $scriptRoot -Base $repoRoot -Label "Repository script path" | Out-Null
$projectTmpRoot = Join-Path $repoRoot ".tmp"
[System.IO.Directory]::CreateDirectory($projectTmpRoot) | Out-Null
Assert-NoReparseChain -Path $projectTmpRoot -Base $repoRoot -Label "Project temporary root" | Out-Null
$rehearsalBase = Join-Path $projectTmpRoot "redis-aof-rehearsals"
[System.IO.Directory]::CreateDirectory($rehearsalBase) | Out-Null
Assert-NoReparseChain -Path $rehearsalBase -Base $projectTmpRoot -Label "Redis AOF rehearsal base" | Out-Null
$runName = "redis-aof-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$runRoot = Assert-StrictDescendant -Path (Join-Path $rehearsalBase $runName) -Base $rehearsalBase -Label "Redis AOF run root"
if (Test-Path -LiteralPath $runRoot) { throw "Redis AOF run root unexpectedly exists" }
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
Assert-NoReparseChain -Path $runRoot -Base $rehearsalBase -Label "Redis AOF run root" | Out-Null

$controlRoot = Join-Path $runRoot "control"
$dataRoot = Join-Path $runRoot "redis-data"
$tlsRoot = Join-Path $runRoot "tls"
foreach ($directory in @($controlRoot, $dataRoot, $tlsRoot)) {
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  Assert-NoReparseChain -Path $directory -Base $runRoot -Label "Redis AOF run directory" | Out-Null
}

$originalEnvironment = @{}
foreach ($name in @(
  "PGPASSWORD", "NODE_ENV", "PETPACK_PLATFORM_MODE", "PETPACK_POSTGRES_URL", "PETPACK_REDIS_URL",
  "PETPACK_REDIS_CA_PEM", "PETPACK_REHEARSAL_API_PORT", "PETPACK_REHEARSAL_OBJECT_PORT",
  "PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT", "PETPACK_REHEARSAL_RESTART_WORKER", "TEMP", "TMP", "TMPDIR"
)) {
  $originalEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
}
$env:TEMP = $runRoot
$env:TMP = $runRoot
$env:TMPDIR = $runRoot

$dockerCommand = @(Get-Command docker -CommandType Application -ErrorAction Stop) |
  Where-Object { $_.Path -and $_.Path.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase) } |
  Select-Object -First 1
if (-not $dockerCommand) { throw "A unique Docker executable was not found" }
$docker = Assert-NotForbiddenDrive -Path $dockerCommand.Path -Label "Docker executable"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeExe = Assert-NotForbiddenDrive -Path $nodeCommand.Source -Label "Node executable"
$OpenSsl = Assert-NotForbiddenDrive -Path $OpenSsl -Label "OpenSSL executable"
$PostgresBin = Assert-NotForbiddenDrive -Path $PostgresBin -Label "PostgreSQL binary directory"

$postgres = Join-Path $PostgresBin "postgres.exe"
$initdb = Join-Path $PostgresBin "initdb.exe"
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$createdb = Join-Path $PostgresBin "createdb.exe"
$harnessEntry = Join-Path $repoRoot "platform\src\development\run-zero-cost-rehearsal.js"
foreach ($required in @($docker, $nodeExe, $OpenSsl, $postgres, $initdb, $pgCtl, $psql, $createdb, $harnessEntry)) {
  Assert-NotForbiddenDrive -Path $required -Label "Required executable or harness path" | Out-Null
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}
$postgresVersion = (& $postgres --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $postgresVersion -notmatch '\b18\.') {
  throw "Redis AOF rehearsal requires PostgreSQL 18"
}

$imageId = (Invoke-CheckedNative -FilePath $docker -Arguments @("image", "inspect", "--format", "{{.Id}}", $RedisImage) | Out-String).Trim()
if ($imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw "Redis image inspection did not return an immutable image ID" }

$redisPassword = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$postgresPassword = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$caKey = Join-Path $tlsRoot "ca.key"
$caCert = Join-Path $tlsRoot "ca.crt"
$serverKey = Join-Path $tlsRoot "redis.key"
$serverCsr = Join-Path $tlsRoot "redis.csr"
$serverCert = Join-Path $tlsRoot "redis.crt"
$requestConfig = Join-Path $tlsRoot "request.cnf"
$redisConfig = Join-Path $runRoot "redis.conf"
$aclFile = Join-Path $runRoot "users.acl"

Write-Utf8NoBomExclusive -Path $requestConfig -Content @"
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
"@
Invoke-CheckedNative -FilePath $OpenSsl -Arguments @(
  "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
  "-subj", "/CN=PetPack Redis AOF Rehearsal CA", "-keyout", $caKey, "-out", $caCert
) | Out-Null
Invoke-CheckedNative -FilePath $OpenSsl -Arguments @(
  "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-config", $requestConfig,
  "-keyout", $serverKey, "-out", $serverCsr
) | Out-Null
Invoke-CheckedNative -FilePath $OpenSsl -Arguments @(
  "x509", "-req", "-sha256", "-days", "2", "-in", $serverCsr, "-CA", $caCert,
  "-CAkey", $caKey, "-CAcreateserial", "-extfile", $requestConfig, "-extensions", "v3", "-out", $serverCert
) | Out-Null

Write-Utf8NoBomExclusive -Path $redisConfig -Content @"
port 0
tls-port 6379
tls-cert-file /run/tls/redis.crt
tls-key-file /run/tls/redis.key
tls-ca-cert-file /run/tls/ca.crt
tls-auth-clients no
bind 0.0.0.0
protected-mode yes
dir /data
appendonly yes
appendfilename appendonly.aof
appenddirname appendonlydir
appendfsync everysec
no-appendfsync-on-rewrite no
aof-use-rdb-preamble yes
aof-load-truncated no
save ""
databases 16
maxmemory 192mb
maxmemory-policy noeviction
"@
Write-Utf8NoBomExclusive -Path $aclFile -Content @"
user default off
user petpack on >$redisPassword ~petpack-*:* &petpack-*:* +@all -acl -bgsave -client|kill -config -debug -flushall -flushdb -migrate -module -monitor -replicaof -save -shutdown -slaveof
"@

$nonce = [guid]::NewGuid().ToString("N")
$containerName = "petpack-redis-aof-$($runName.Substring($runName.Length - 8))"
$redisPort = Get-LoopbackPort
$expectedMounts = @{
  "/data" = @{ Source = $dataRoot; ReadWrite = $true }
  "/config/redis.conf" = @{ Source = $redisConfig; ReadWrite = $false }
  "/config/users.acl" = @{ Source = $aclFile; ReadWrite = $false }
  "/run/tls/ca.crt" = @{ Source = $caCert; ReadWrite = $false }
  "/run/tls/redis.crt" = @{ Source = $serverCert; ReadWrite = $false }
  "/run/tls/redis.key" = @{ Source = $serverKey; ReadWrite = $false }
}
$createArguments = @(
  "create", "--pull", "never", "--name", $containerName,
  "--label", "petpack.rehearsal.kind=redis-aof",
  "--label", "petpack.rehearsal.nonce=$nonce",
  "--restart", "no", "--network", "bridge", "--publish", "127.0.0.1:${redisPort}:6379",
  "--read-only", "--user", "redis", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.50",
  "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=8m",
  "--mount", "type=bind,src=$dataRoot,dst=/data",
  "--mount", "type=bind,src=$redisConfig,dst=/config/redis.conf,readonly",
  "--mount", "type=bind,src=$aclFile,dst=/config/users.acl,readonly",
  "--mount", "type=bind,src=$caCert,dst=/run/tls/ca.crt,readonly",
  "--mount", "type=bind,src=$serverCert,dst=/run/tls/redis.crt,readonly",
  "--mount", "type=bind,src=$serverKey,dst=/run/tls/redis.key,readonly",
  $RedisImage, "redis-server", "/config/redis.conf", "--aclfile", "/config/users.acl"
)

$containerId = $null
$containerCreated = $false
$serverStarted = $false
$harness = $null
$checkpointAofEvidence = $null
$beforePersistence = $null
$afterPersistence = $null
$workflowResult = $null
$workflowReport = $null
$postgresPort = 0
$apiPort = 0
$objectPort = 0
$postgresData = Join-Path $runRoot "postgres-data"
$postgresLog = Join-Path $runRoot "postgres.log"
$postgresStartStdout = Join-Path $runRoot "pg-ctl-start.stdout.log"
$postgresStartStderr = Join-Path $runRoot "pg-ctl-start.stderr.log"
$postgresPasswordFile = Join-Path $runRoot "postgres_password"
$stdoutPath = Join-Path $runRoot "harness.stdout.log"
$stderrPath = Join-Path $runRoot "harness.stderr.log"
$readyPath = Join-Path $controlRoot "ready.json"
$resumePath = Join-Path $controlRoot "resume.json"

try {
  $createOutput = Invoke-CheckedNative -FilePath $docker -Arguments $createArguments
  $containerId = @($createOutput | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -match '^[a-f0-9]{64}$' })[-1]
  if (-not $containerId) { throw "Docker create did not return a full Redis container ID" }
  $containerCreated = $true
  Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "created" | Out-Null
  Invoke-CheckedNative -FilePath $docker -Arguments @("start", $containerId) | Out-Null
  $runningInspection = Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "running"
  if ((Get-RedisHostPort -Inspection $runningInspection) -ne $redisPort) {
    throw "Owned Redis did not bind its preselected loopback port"
  }
  Wait-RedisTlsReady -Docker $docker -ContainerId $containerId -Password $redisPassword
  Assert-RedisPlaintextRejected -Docker $docker -ContainerId $containerId -Password $redisPassword
  for ($portAttempt = 0; $portAttempt -lt 10; $portAttempt += 1) {
    $candidatePorts = @(
      Get-LoopbackPort
      Get-LoopbackPort
      Get-LoopbackPort
    )
    if (-not ($candidatePorts -contains $redisPort) -and
        @($candidatePorts | Group-Object | Where-Object Count -gt 1).Count -eq 0) {
      $postgresPort, $apiPort, $objectPort = $candidatePorts
      break
    }
  }
  if ($postgresPort -eq 0 -or $apiPort -eq 0 -or $objectPort -eq 0) {
    throw "Redis AOF rehearsal could not reserve distinct loopback port candidates"
  }

  Write-Utf8NoBomExclusive -Path $postgresPasswordFile -Content ($postgresPassword + "`n")
  Invoke-CheckedNative -FilePath $initdb -Arguments @(
    "-D", $postgresData, "-U", "petpack_app", "--pwfile=$postgresPasswordFile",
    "--auth-host=scram-sha-256", "--auth-local=trust", "--data-checksums", "--no-locale", "--encoding=UTF8"
  ) | Out-Null
  $postgresConfig = Join-Path $postgresData "postgresql.conf"
  [System.IO.File]::AppendAllText($postgresConfig, @"

listen_addresses = '127.0.0.1'
port = $postgresPort
password_encryption = 'scram-sha-256'
"@, [System.Text.UTF8Encoding]::new($false))
  $postgresStartProcess = Start-Process -FilePath $pgCtl -ArgumentList @(
    "start", "-D", $postgresData, "-l", $postgresLog, "-w", "-t", "30"
  ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $postgresStartStdout `
    -RedirectStandardError $postgresStartStderr
  if (-not $postgresStartProcess.WaitForExit(30000)) {
    $postgresStartProcess.Kill($true)
    $postgresStartProcess.WaitForExit()
    & $pgCtl status -D $postgresData *> $null
    if ($LASTEXITCODE -eq 0) { & $pgCtl stop -D $postgresData -m fast -w -t 30 | Out-Null }
    throw "The isolated pg_ctl start process timed out"
  }
  $postgresStartProcess.Refresh()
  if ($postgresStartProcess.ExitCode -ne 0) {
    throw "The isolated PostgreSQL process did not start; inspect the retained pg_ctl logs"
  }
  $serverStarted = $true
  $env:PGPASSWORD = $postgresPassword
  Invoke-CheckedNative -FilePath $createdb -Arguments @(
    "--host=127.0.0.1", "--port=$postgresPort", "--username=petpack_app", "petpack_studio"
  ) | Out-Null
  $migrationLog = Join-Path $runRoot "migrations.log"
  foreach ($migration in Get-ChildItem -LiteralPath (Join-Path $repoRoot "platform\sql") -Filter "*.sql" -File | Sort-Object Name) {
    $migrationOutput = (& $psql --host=127.0.0.1 --port=$postgresPort --username=petpack_app --dbname=petpack_studio `
      --set=ON_ERROR_STOP=1 --single-transaction "--file=$($migration.FullName)" 2>&1 | Out-String)
    [System.IO.File]::AppendAllText($migrationLog, "[$($migration.Name)]`n$migrationOutput", [System.Text.UTF8Encoding]::new($false))
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($migration.Name); inspect the retained migration log" }
  }

  $encodedPostgresPassword = [System.Uri]::EscapeDataString($postgresPassword)
  $encodedRedisPassword = [System.Uri]::EscapeDataString($redisPassword)
  $env:NODE_ENV = "development"
  $env:PETPACK_PLATFORM_MODE = "development"
  $env:PETPACK_POSTGRES_URL = "postgresql://petpack_app:${encodedPostgresPassword}@127.0.0.1:${postgresPort}/petpack_studio"
  $env:PETPACK_REDIS_URL = "rediss://petpack:${encodedRedisPassword}@127.0.0.1:${redisPort}/15"
  $env:PETPACK_REDIS_CA_PEM = Get-Content -LiteralPath $caCert -Raw
  $env:PETPACK_REHEARSAL_API_PORT = [string]$apiPort
  $env:PETPACK_REHEARSAL_OBJECT_PORT = [string]$objectPort
  $env:PETPACK_REHEARSAL_REDIS_AOF_CONTROL_ROOT = $controlRoot
  $env:PETPACK_REHEARSAL_RESTART_WORKER = "false"

  $harness = Start-Process -FilePath $nodeExe -ArgumentList @($harnessEntry) -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $ready = Wait-ForJsonEvidenceFile -Path $readyPath -Base $controlRoot -Process $harness -TimeoutSeconds 300
  if ($ready.schemaVersion -ne "petpack-redis-aof-ready/v1" -or [string]::IsNullOrWhiteSpace([string]$ready.nonce) -or
      [int]$ready.before.counts.waiting -ne 6 -or [int]$ready.before.counts.delayed -ne 1 -or
      [int]$ready.before.counts.active -ne 0 -or [int]$ready.before.counts.failed -ne 0 -or
      [int]$ready.before.counts.prioritized -ne 0 -or [int]$ready.before.counts.'waiting-children' -ne 0 -or
      [int]$ready.before.counts.repeat -ne 0 -or
      @($ready.before.jobs).Count -ne 7) {
    throw "Zero-cost harness returned an invalid Redis AOF checkpoint"
  }

  Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "running" | Out-Null
  $beforePersistence = Get-RedisPersistenceEvidence -Docker $docker -ContainerId $containerId -Password $redisPassword
  $waitAof = Invoke-RedisTls -Docker $docker -ContainerId $containerId -Password $redisPassword -Command @("WAITAOF", "1", "0", "5000")
  $localFsync = 0
  if ($waitAof.Count -lt 1 -or -not [int]::TryParse(([string]$waitAof[0]).Trim(), [ref]$localFsync) -or $localFsync -lt 1) {
    throw "Owned Redis did not confirm a local AOF fsync"
  }

  Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "running" | Out-Null
  Invoke-CheckedNative -FilePath $docker -Arguments @("stop", "--time", "10", $containerId) | Out-Null
  $stoppedInspection = Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "exited"
  if ([int]$stoppedInspection.State.ExitCode -ne 0) { throw "Owned Redis did not stop cleanly at the AOF checkpoint" }
  $checkpointAofEvidence = Get-AofFileEvidence -DataRoot $dataRoot -RunRoot $runRoot

  Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "exited" | Out-Null
  Invoke-CheckedNative -FilePath $docker -Arguments @("start", $containerId) | Out-Null
  $restartedInspection = Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
    -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "running"
  if ((Get-RedisHostPort -Inspection $restartedInspection) -ne $redisPort) {
    throw "Owned Redis loopback port changed across restart"
  }
  Wait-RedisTlsReady -Docker $docker -ContainerId $containerId -Password $redisPassword
  $afterPersistence = Get-RedisPersistenceEvidence -Docker $docker -ContainerId $containerId -Password $redisPassword
  Write-Utf8NoBomExclusive -Path $resumePath -Content (([ordered]@{
    schemaVersion = "petpack-redis-aof-resume/v1"
    nonce = [string]$ready.nonce
    containerId = $containerId
    sameContainerRestarted = $true
    restartedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json -Depth 4) + "`n")

  if (-not $harness.WaitForExit(420000)) {
    Stop-OwnedChildProcess -Process $harness -Label "Redis AOF zero-cost harness"
    throw "Redis AOF zero-cost harness timed out; inspect retained logs under $runRoot"
  }
  $harness.Refresh()
  if ($harness.ExitCode -ne 0) { throw "Redis AOF zero-cost harness failed; inspect retained logs under $runRoot" }
  $resultLine = @(Get-Content -LiteralPath $stdoutPath | Where-Object { $_ -match '^\{"ok":true,' })[-1]
  if (-not $resultLine) { throw "Redis AOF zero-cost harness did not return its final report" }
  $workflowResult = $resultLine | ConvertFrom-Json
  $workflowReportPath = Assert-NoReparseChain -Path ([string]$workflowResult.reportPath) `
    -Base (Join-Path $repoRoot ".tmp\zero-cost-rehearsals") -Label "Zero-cost workflow report"
  if (-not (Test-Path -LiteralPath $workflowReportPath -PathType Leaf)) { throw "Zero-cost workflow report is missing" }
  $workflowReport = Get-Content -LiteralPath $workflowReportPath -Raw | ConvertFrom-Json
  if ([int]$workflowReport.externalCallCount -ne 0 -or $workflowReport.zeroCost -ne $true -or
      [int]$workflowReport.workflow.sourcePhotos -ne 3 -or [int]$workflowReport.workflow.passedMasters -ne 3 -or
      [int]$workflowReport.workflow.passedActions -ne 7 -or [int]$workflowReport.workflow.passedQaReports -ne 12 -or
      [int]$workflowReport.workflow.failedQaReports -ne 0 -or [int]$workflowReport.workflow.totalExecutions -ne 38 -or
      [int]$workflowReport.workflow.succeededExecutions -ne 38 -or [int]$workflowReport.workflow.incompleteExecutions -ne 0 -or
      [int]$workflowReport.workflow.totalOutboxJobs -ne 39 -or [int]$workflowReport.workflow.sentOutboxJobs -ne 39 -or
      [int]$workflowReport.workflow.unsentOutboxJobs -ne 0 -or [int]$workflowReport.workflow.fixtureUsageAttempts -ne 10 -or
      [string]$workflowReport.workflow.runState -ne "deliverable" -or [string]$workflowReport.delivery.status -ne "ready" -or
      $workflowReport.delivery.clientImport.ok -ne $true -or
      [string]$workflowReport.delivery.clientImport.packageId -ne [string]$workflowReport.delivery.packageId -or
      [int]$workflowReport.delivery.clientImport.fileCount -ne [int]$workflowReport.delivery.archiveFileCount -or
      $workflowReport.redisAofRestart.sameContainerRestarted -ne $true -or
      [string]$workflowReport.redisAofRestart.containerId -ne $containerId -or
      [int]$workflowReport.redisAofRestart.restoredJobCount -ne 7 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.completed -ne 39 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.waiting -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.delayed -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.active -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.failed -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.prioritized -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.'waiting-children' -ne 0 -or
      [int]$workflowReport.redisAofRestart.finalQueue.counts.repeat -ne 0) {
    throw "Redis AOF zero-cost workflow completed with an invalid final contract"
  }
} finally {
  if ($harness -and -not $harness.HasExited) {
    try { Stop-OwnedChildProcess -Process $harness -Label "Redis AOF zero-cost harness" } catch {
      Write-Warning "The exact owned zero-cost harness did not stop cleanly; inspect $runRoot"
    }
  }
  if ($serverStarted) {
    & $pgCtl stop -D $postgresData -m fast -w -t 30 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "The isolated PostgreSQL process did not stop cleanly; inspect $runRoot" }
  }
  if ($containerCreated -and $containerId -match '^[a-f0-9]{64}$') {
    try {
      $finalInspection = Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
        -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort
      if ([string]$finalInspection.State.Status -eq "running") {
        Invoke-CheckedNative -FilePath $docker -Arguments @("stop", "--time", "10", $containerId) | Out-Null
      }
    } catch {
      Write-Warning "The exact owned Redis container could not be retained in a stopped state; inspect $runRoot"
    }
  }
  foreach ($entry in $originalEnvironment.GetEnumerator()) {
    [System.Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, "Process")
  }
}

$retainedInspection = Assert-OwnedRedisContainer -Docker $docker -ContainerId $containerId -ContainerName $containerName `
  -Nonce $nonce -ImageId $imageId -RunRoot $runRoot -ExpectedMounts $expectedMounts -ExpectedHostPort $redisPort -ExpectedState "exited"
$finalAofEvidence = Get-AofFileEvidence -DataRoot $dataRoot -RunRoot $runRoot
$report = [ordered]@{
  schemaVersion = "petpack-local-redis-aof-rehearsal/v1"
  runRoot = $runRoot
  controlRoot = $controlRoot
  workflowReport = [string]$workflowResult.reportPath
  postgresVersion = $postgresVersion
  redisImage = $RedisImage
  redisImageId = $imageId
  redisContainerName = $containerName
  redisContainerId = $containerId
  redisPort = $redisPort
  tlsOnly = $true
  plaintextRejected = $true
  aof = [ordered]@{
    appendFsync = "everysec"
    beforeStop = $beforePersistence
    afterRestart = $afterPersistence
    checkpointFiles = $checkpointAofEvidence
    finalFiles = $finalAofEvidence
  }
  queueCheckpoint = $workflowReport.redisAofRestart
  fullWorkflowContract = $true
  externalProviderCallCount = [int]$workflowReport.externalCallCount
  exactFullContainerIdOnly = $true
  sameContainerRestarted = $true
  loopbackDedicatedPortOnly = $true
  bindMountsConfinedToUniqueRunRoot = $true
  dockerDeleteUsed = $false
  destructiveRedisCommandUsed = $false
  hostPathDeleted = $false
  forbiddenDriveAccessUsed = $false
  containerState = [string]$retainedInspection.State.Status
  retainedForAudit = $true
}
$reportPath = Join-Path $runRoot "report.json"
Write-Utf8NoBomExclusive -Path $reportPath -Content (($report | ConvertTo-Json -Depth 16) + "`n")
Write-Output "REDIS_AOF_REHEARSAL_OK=$reportPath"
