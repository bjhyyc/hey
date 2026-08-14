[CmdletBinding()]
param(
  [string]$RedisImage = "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
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
  return $output
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

if ($RedisImage -notmatch '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$') {
  throw "RedisImage must be an immutable repository@sha256 reference"
}

$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot "..\..\.."))
$rehearsalBase = Join-Path $repoRoot ".tmp\data-redis-tls-rehearsals"
[System.IO.Directory]::CreateDirectory($rehearsalBase) | Out-Null
$baseInfo = Get-Item -LiteralPath $rehearsalBase -Force
if (($baseInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Redis rehearsal base must not be a reparse point"
}

$runName = "redis-tls-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$runRoot = Join-Path $rehearsalBase $runName
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
$expectedPrefix = $rehearsalBase.TrimEnd('\') + '\'
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Redis rehearsal path escaped the approved D-drive directory"
}

$docker = (Get-Command docker -ErrorAction Stop).Source
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
if (-not (Test-Path -LiteralPath $openssl -PathType Leaf)) {
  throw "OpenSSL is missing: $openssl"
}
Invoke-CheckedNative -FilePath $docker -Arguments @("image", "inspect", $RedisImage) | Out-Null

$password = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$caKey = Join-Path $runRoot "ca.key"
$caCert = Join-Path $runRoot "ca.crt"
$serverKey = Join-Path $runRoot "redis.key"
$serverCsr = Join-Path $runRoot "redis.csr"
$serverCert = Join-Path $runRoot "redis.crt"
$requestConfig = Join-Path $runRoot "request.cnf"
$redisConfig = Join-Path $runRoot "redis.conf"
$aclFile = Join-Path $runRoot "users.acl"

Write-Utf8NoBom -Path $requestConfig -Content @"
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
Invoke-CheckedNative -FilePath $openssl -Arguments @(
  "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
  "-subj", "/CN=PetPack Local Redis Test CA", "-keyout", $caKey, "-out", $caCert
) | Out-Null
Invoke-CheckedNative -FilePath $openssl -Arguments @(
  "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-config", $requestConfig,
  "-keyout", $serverKey, "-out", $serverCsr
) | Out-Null
Invoke-CheckedNative -FilePath $openssl -Arguments @(
  "x509", "-req", "-sha256", "-days", "2", "-in", $serverCsr, "-CA", $caCert,
  "-CAkey", $caKey, "-CAcreateserial", "-extfile", $requestConfig, "-extensions", "v3",
  "-out", $serverCert
) | Out-Null

Write-Utf8NoBom -Path $redisConfig -Content @"
port 0
tls-port 6379
tls-cert-file /run/tls/redis.crt
tls-key-file /run/tls/redis.key
tls-ca-cert-file /run/tls/ca.crt
tls-auth-clients no
bind 127.0.0.1
protected-mode yes
dir /data
appendonly no
save ""
databases 1
"@
Write-Utf8NoBom -Path $aclFile -Content @"
user default off
user petpack on >$password ~petpack:* &petpack:* +@all -acl -bgsave -client|kill -config -debug -flushall -flushdb -migrate -module -monitor -replicaof -save -shutdown -slaveof
"@

$containerName = "petpack-redis-tls-rehearsal-$($runName.Substring($runName.Length - 8))"
$created = $false
$started = $false
$plainRejected = $false
$namespaceRejected = $false
$destructiveRejected = $false
try {
  $createArgs = @(
    "create", "--name", $containerName,
    "--network", "none",
    "--read-only",
    "--user", "redis",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "256m",
    "--cpus", "0.50",
    "--tmpfs", "/data:rw,nosuid,nodev,size=32m",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=8m",
    "--mount", "type=bind,src=$redisConfig,dst=/config/redis.conf,readonly",
    "--mount", "type=bind,src=$aclFile,dst=/config/users.acl,readonly",
    "--mount", "type=bind,src=$caCert,dst=/run/tls/ca.crt,readonly",
    "--mount", "type=bind,src=$serverCert,dst=/run/tls/redis.crt,readonly",
    "--mount", "type=bind,src=$serverKey,dst=/run/tls/redis.key,readonly",
    $RedisImage,
    "redis-server", "/config/redis.conf", "--aclfile", "/config/users.acl"
  )
  Invoke-CheckedNative -FilePath $docker -Arguments $createArgs | Out-Null
  $created = $true
  Invoke-CheckedNative -FilePath $docker -Arguments @("start", $containerName) | Out-Null
  $started = $true

  $pong = $null
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $pong = & $docker exec --env "REDISCLI_AUTH=$password" $containerName redis-cli `
      --tls --cacert /run/tls/ca.crt --user petpack -h 127.0.0.1 ping 2>$null
    if ($LASTEXITCODE -eq 0 -and ($pong | Out-String).Trim() -eq "PONG") { break }
    Start-Sleep -Milliseconds 250
  }
  if (($pong | Out-String).Trim() -ne "PONG") {
    throw "Redis TLS readiness probe failed"
  }

  & $docker exec --env "REDISCLI_AUTH=$password" $containerName redis-cli `
    --user petpack -h 127.0.0.1 -p 6379 ping 1>$null 2>$null
  $plainRejected = $LASTEXITCODE -ne 0
  if (-not $plainRejected) { throw "Redis unexpectedly accepted plaintext" }

  $allowed = (& $docker exec --env "REDISCLI_AUTH=$password" $containerName redis-cli `
    --tls --cacert /run/tls/ca.crt --user petpack -h 127.0.0.1 `
    SET petpack:rehearsal:marker ok 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $allowed -ne "OK") { throw "Redis allowed-prefix write failed" }

  $namespaceOutput = (& $docker exec --env "REDISCLI_AUTH=$password" $containerName redis-cli `
    --tls --cacert /run/tls/ca.crt --user petpack -h 127.0.0.1 `
    SET outside:rehearsal:marker denied 2>&1 | Out-String).Trim()
  $namespaceRejected = $namespaceOutput -match "NOPERM"
  if (-not $namespaceRejected) { throw "Redis ACL accepted an out-of-prefix key" }

  $destructiveOutput = (& $docker exec --env "REDISCLI_AUTH=$password" $containerName redis-cli `
    --tls --cacert /run/tls/ca.crt --user petpack -h 127.0.0.1 `
    FLUSHALL 2>&1 | Out-String).Trim()
  $destructiveRejected = $destructiveOutput -match "NOPERM"
  if (-not $destructiveRejected) { throw "Redis ACL accepted FLUSHALL" }

  $mountSources = & $docker inspect $containerName --format '{{range .Mounts}}{{println .Source}}{{end}}'
  if ($LASTEXITCODE -ne 0) { throw "Redis mount inspection failed" }
  foreach ($source in $mountSources) {
    if (-not [string]::IsNullOrWhiteSpace($source) -and
        -not [System.IO.Path]::GetFullPath($source).StartsWith($runRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Redis rehearsal mounted a path outside its unique run directory"
    }
  }
} finally {
  if ($started) {
    & $docker stop --time 10 $containerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "The Redis rehearsal container did not stop cleanly: $containerName"
    }
  }
}

if (-not $created) { throw "Redis rehearsal container was not created" }
$containerState = (& $docker inspect $containerName --format '{{.State.Status}}' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $containerState -ne "exited") {
  throw "Redis rehearsal container was not retained in the stopped state"
}
$report = [ordered]@{
  schemaVersion = "petpack-local-redis-tls-rehearsal/v1"
  runRoot = $runRoot
  containerName = $containerName
  immutableImage = $RedisImage
  tlsAuthenticated = $true
  plaintextRejected = $plainRejected
  namespaceRejected = $namespaceRejected
  destructiveCommandRejected = $destructiveRejected
  hostPortsPublished = $false
  containerState = $containerState
  retainedForAudit = $true
}
$reportPath = Join-Path $runRoot "report.json"
Write-Utf8NoBom -Path $reportPath -Content (($report | ConvertTo-Json -Depth 4) + "`n")
Write-Output "REDIS_TLS_REHEARSAL_OK=$reportPath"
