[CmdletBinding()]
param(
  [string]$PostgresBin = "D:\PostgreSQL 15\bin"
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

function Convert-ToGitBashPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.Length -lt 3 -or $full[1] -ne ':') {
    throw "Expected a Windows drive path: $Path"
  }
  $drive = $full.Substring(0, 1).ToLowerInvariant()
  $tail = $full.Substring(2).Replace('\', '/')
  return "/$drive$tail"
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot "..\..\.."))
$rehearsalBase = Join-Path $repoRoot ".tmp\data-tls-rehearsals"
[System.IO.Directory]::CreateDirectory($rehearsalBase) | Out-Null
$baseInfo = Get-Item -LiteralPath $rehearsalBase -Force
if (($baseInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Rehearsal base must not be a reparse point"
}

$runName = "data-tls-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$runRoot = Join-Path $rehearsalBase $runName
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
$expectedPrefix = $rehearsalBase.TrimEnd('\') + '\'
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Rehearsal path escaped the approved D-drive directory"
}

$postgres = Join-Path $PostgresBin "postgres.exe"
$initdb = Join-Path $PostgresBin "initdb.exe"
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$createdb = Join-Path $PostgresBin "createdb.exe"
$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
$bash = "C:\Program Files\Git\bin\bash.exe"
foreach ($required in @($postgres, $initdb, $pgCtl, $psql, $createdb, $openssl, $bash)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required executable is missing: $required"
  }
}

$versionText = (& $postgres --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '\b18\.') {
  throw "The rehearsal requires PostgreSQL 18"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$dataDir = Join-Path $runRoot "data"
$certDir = Join-Path $runRoot "tls"
$migrationDir = Join-Path $runRoot "migrations"
[System.IO.Directory]::CreateDirectory($certDir) | Out-Null
[System.IO.Directory]::CreateDirectory($migrationDir) | Out-Null

$adminPassword = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$appPassword = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$adminPasswordFile = Join-Path $runRoot "postgres_admin_password"
$appPasswordFile = Join-Path $runRoot "postgres_app_password"
Write-Utf8NoBom -Path $adminPasswordFile -Content ($adminPassword + "`n")
Write-Utf8NoBom -Path $appPasswordFile -Content ($appPassword + "`n")

$caKey = Join-Path $certDir "ca.key"
$caCert = Join-Path $certDir "ca.crt"
$serverKey = Join-Path $certDir "server.key"
$serverCsr = Join-Path $certDir "server.csr"
$serverCert = Join-Path $certDir "server.crt"
$requestConfig = Join-Path $certDir "request.cnf"
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
  "-subj", "/CN=PetPack Local PostgreSQL Test CA", "-keyout", $caKey, "-out", $caCert
)
Invoke-CheckedNative -FilePath $openssl -Arguments @(
  "req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-config", $requestConfig,
  "-keyout", $serverKey, "-out", $serverCsr
)
Invoke-CheckedNative -FilePath $openssl -Arguments @(
  "x509", "-req", "-sha256", "-days", "2", "-in", $serverCsr, "-CA", $caCert,
  "-CAkey", $caKey, "-CAcreateserial", "-extfile", $requestConfig, "-extensions", "v3",
  "-out", $serverCert
)

Invoke-CheckedNative -FilePath $initdb -Arguments @(
  "-D", $dataDir, "-U", "petpack_admin", "--pwfile=$adminPasswordFile",
  "--auth-host=scram-sha-256", "--auth-local=trust", "--data-checksums", "--no-locale", "--encoding=UTF8"
)

$hbaSource = Join-Path $scriptRoot "postgres\pg_hba.conf"
$hbaTarget = Join-Path $runRoot "pg_hba.conf"
[System.IO.File]::Copy($hbaSource, $hbaTarget, $false)
$toPgPath = {
  param([string]$Value)
  return $Value.Replace('\', '/').Replace("'", "''")
}
$postgresConfig = Join-Path $dataDir "postgresql.conf"
$settings = @"

listen_addresses = '127.0.0.1'
port = $port
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
ssl_cert_file = '$(& $toPgPath $serverCert)'
ssl_key_file = '$(& $toPgPath $serverKey)'
ssl_ca_file = '$(& $toPgPath $caCert)'
hba_file = '$(& $toPgPath $hbaTarget)'
password_encryption = 'scram-sha-256'
"@
[System.IO.File]::AppendAllText($postgresConfig, $settings, [System.Text.UTF8Encoding]::new($false))

$serverLog = Join-Path $runRoot "postgres.log"
$started = $false
$childProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
try {
  Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start", "-D", $dataDir, "-l", $serverLog, "-w", "-t", "30")
  $started = $true

  $env:PGPASSWORD = $adminPassword
  $env:PGSSLMODE = "verify-full"
  $env:PGSSLROOTCERT = $caCert
  Invoke-CheckedNative -FilePath $createdb -Arguments @(
    "--host=localhost", "--port=$port", "--username=petpack_admin", "petpack_studio"
  )

  Get-ChildItem -LiteralPath (Join-Path $repoRoot "platform\sql") -Filter "*.sql" -File |
    Sort-Object Name |
    ForEach-Object { [System.IO.File]::Copy($_.FullName, (Join-Path $migrationDir $_.Name), $false) }
  Write-Utf8NoBom -Path (Join-Path $migrationDir "015_rehearsal_lock.sql") -Content @"
SELECT pg_sleep(3);
CREATE TABLE data_tls_rehearsal_marker(id INTEGER PRIMARY KEY);
"@

  $runnerPath = Join-Path $scriptRoot "run-migrations.sh"
  $wrapperPath = Join-Path $runRoot "run-migrations-wrapper.sh"
  $postgresBinBash = Convert-ToGitBashPath $PostgresBin
  $runnerBash = Convert-ToGitBashPath $runnerPath
  Write-Utf8NoBom -Path $wrapperPath -Content @"
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="$postgresBinBash`:`$PATH"
exec "$runnerBash"
"@

  $env:PETPACK_MIGRATION_TEST_MODE = "1"
  $env:PETPACK_MIGRATIONS_DIR = Convert-ToGitBashPath $migrationDir
  $env:PETPACK_POSTGRES_ADMIN_PASSWORD_FILE = Convert-ToGitBashPath $adminPasswordFile
  $env:PETPACK_POSTGRES_APP_PASSWORD_FILE = Convert-ToGitBashPath $appPasswordFile
  $env:PETPACK_POSTGRES_CA_FILE = Convert-ToGitBashPath $caCert
  $env:PGHOST = "localhost"
  $env:PGPORT = [string]$port

  $wrapperBash = Convert-ToGitBashPath $wrapperPath
  $stdoutOne = Join-Path $runRoot "migration-one.stdout.log"
  $stderrOne = Join-Path $runRoot "migration-one.stderr.log"
  $stdoutTwo = Join-Path $runRoot "migration-two.stdout.log"
  $stderrTwo = Join-Path $runRoot "migration-two.stderr.log"
  $first = Start-Process -FilePath $bash -ArgumentList @($wrapperBash) -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdoutOne -RedirectStandardError $stderrOne
  $childProcesses.Add($first)
  Start-Sleep -Milliseconds 250
  $second = Start-Process -FilePath $bash -ArgumentList @($wrapperBash) -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdoutTwo -RedirectStandardError $stderrTwo
  $childProcesses.Add($second)
  if (-not $first.WaitForExit(60000) -or -not $second.WaitForExit(60000)) {
    throw "Concurrent migration rehearsal timed out"
  }
  $first.Refresh()
  $second.Refresh()
  if ($first.ExitCode -ne 0 -or $second.ExitCode -ne 0) {
    throw "Concurrent migrations failed; inspect the retained rehearsal logs"
  }
  $migrationOutput = (Get-Content -LiteralPath $stdoutOne -Raw) + (Get-Content -LiteralPath $stdoutTwo -Raw)
  if ([regex]::Matches($migrationOutput, "Applying: 015_rehearsal_lock.sql").Count -ne 1 -or
      [regex]::Matches($migrationOutput, "Already applied: 015_rehearsal_lock.sql").Count -ne 1) {
    throw "The advisory lock did not serialize concurrent migration runners"
  }

  $env:PGPASSWORD = $appPassword
  $env:PGSSLMODE = "verify-full"
  $env:PGSSLROOTCERT = $caCert
  $positive = (& $psql --host=localhost --port=$port --username=petpack_app --dbname=petpack_studio `
    --tuples-only --no-align --command="SELECT current_user || '|' || ssl || '|' || version || '|' || (SELECT count(*) FROM schema_migration) FROM pg_stat_ssl WHERE pid=pg_backend_pid();" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $positive -notmatch '^petpack_app\|true\|TLSv1\.[23]\|15$') {
    throw "Authenticated verify-full PostgreSQL probe failed: $positive"
  }

  $negativeLog = Join-Path $runRoot "plaintext-negative.log"
  $env:PGSSLMODE = "disable"
  & $psql --host=localhost --port=$port --username=petpack_app --dbname=petpack_studio `
    --tuples-only --no-align --command="SELECT 1" 1>$null 2>$negativeLog
  $plaintextExitCode = $LASTEXITCODE
  if ($plaintextExitCode -eq 0) {
    throw "PostgreSQL unexpectedly accepted a plaintext connection"
  }

  $parts = $positive.Split('|')
  $report = [ordered]@{
    schemaVersion = "petpack-local-data-tls-rehearsal/v1"
    runRoot = $runRoot
    postgresVersion = $versionText
    port = $port
    tlsProtocol = $parts[2]
    migrationCount = [int]$parts[3]
    concurrentMigrationExitCodes = @($first.ExitCode, $second.ExitCode)
    plaintextRejected = $true
    retainedForAudit = $true
  }
  $reportPath = Join-Path $runRoot "report.json"
  Write-Utf8NoBom -Path $reportPath -Content (($report | ConvertTo-Json -Depth 4) + "`n")
  Write-Output "DATA_TLS_REHEARSAL_OK=$reportPath"
} finally {
  foreach ($child in $childProcesses) {
    if (-not $child.HasExited) {
      Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($started) {
    & $pgCtl stop -D $dataDir -m fast -w -t 30 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "The isolated PostgreSQL process did not stop cleanly; inspect $runRoot"
    }
  }
}
