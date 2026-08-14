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

function Wait-ForFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 45
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return }
    if ($Process.HasExited) {
      throw "PostgreSQL outage verifier exited before writing $Path"
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for PostgreSQL outage evidence: $Path"
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
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
$approvedBase = [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".tmp\data-tls-rehearsals"))
$baseInfo = Get-Item -LiteralPath $approvedBase -Force
if (($baseInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "PostgreSQL rehearsal base must not be a reparse point"
}

$tlsScript = Join-Path $scriptRoot "run-local-tls-rehearsal.ps1"
$launchRoot = Join-Path $approvedBase ("outage-launch-{0}" -f ([guid]::NewGuid().ToString("N").Substring(0, 8)))
[System.IO.Directory]::CreateDirectory($launchRoot) | Out-Null
$launchInfo = Get-Item -LiteralPath $launchRoot -Force
if (($launchInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "PostgreSQL outage launch root must not be a reparse point"
}
$pwshCommand = Get-Command pwsh -CommandType Application -ErrorAction Stop
$pwshExe = $pwshCommand.Source
$tlsStdout = Join-Path $launchRoot "tls-rehearsal.stdout.log"
$tlsStderr = Join-Path $launchRoot "tls-rehearsal.stderr.log"
$quotedTlsScript = '"' + $tlsScript + '"'
$quotedPostgresBin = '"' + $PostgresBin + '"'
$tlsProcess = Start-Process -FilePath $pwshExe -ArgumentList @(
  "-NoProfile", "-NonInteractive", "-File", $quotedTlsScript, "-PostgresBin", $quotedPostgresBin
) -NoNewWindow -PassThru -RedirectStandardOutput $tlsStdout -RedirectStandardError $tlsStderr
if (-not $tlsProcess.WaitForExit(120000)) {
  Stop-OwnedChildProcess -Process $tlsProcess -Label "TLS rehearsal"
  throw "TLS rehearsal timed out; inspect retained logs under $launchRoot"
}
$tlsProcess.Refresh()
if ($tlsProcess.ExitCode -ne 0) {
  throw "TLS rehearsal failed; inspect retained logs under $launchRoot"
}
$tlsReportLine = @(Get-Content -LiteralPath $tlsStdout | Where-Object { $_.StartsWith("DATA_TLS_REHEARSAL_OK=") })[-1]
if (-not $tlsReportLine) { throw "TLS rehearsal did not return a report path" }
$tlsReportPath = $tlsReportLine.Substring("DATA_TLS_REHEARSAL_OK=".Length)
$tlsReport = Get-Content -LiteralPath $tlsReportPath -Raw | ConvertFrom-Json
$runRoot = [System.IO.Path]::GetFullPath([string]$tlsReport.runRoot)
$expectedPrefix = $approvedBase.TrimEnd('\') + '\'
if (-not $runRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "PostgreSQL outage rehearsal escaped the approved D-drive directory"
}
$runInfo = Get-Item -LiteralPath $runRoot -Force
if (($runInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "PostgreSQL outage run root must not be a reparse point"
}

$dataDir = Join-Path $runRoot "data"
$caFile = Join-Path $runRoot "tls\ca.crt"
$appPasswordFile = Join-Path $runRoot "postgres_app_password"
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeExe = $nodeCommand.Source
$verifierScript = Join-Path $repoRoot "platform\src\development\verify-postgres-outage-recovery.js"
foreach ($required in @($dataDir, $caFile, $appPasswordFile, $pgCtl, $nodeExe, $verifierScript)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required outage rehearsal path is missing: $required" }
}

$controlRoot = Join-Path $runRoot ("outage-control-{0}" -f ([guid]::NewGuid().ToString("N").Substring(0, 8)))
[System.IO.Directory]::CreateDirectory($controlRoot) | Out-Null
$controlInfo = Get-Item -LiteralPath $controlRoot -Force
if (($controlInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "PostgreSQL outage control root must not be a reparse point"
}

$password = (Get-Content -LiteralPath $appPasswordFile -Raw).Trim()
$encodedPassword = [System.Uri]::EscapeDataString($password)
$port = [int]$tlsReport.port
$env:PETPACK_PLATFORM_MODE = "development"
$env:PETPACK_REHEARSAL_CONTROL_ROOT = $controlRoot
$env:PETPACK_REHEARSAL_POSTGRES_URL = "postgresql://petpack_app:${encodedPassword}@localhost:${port}/petpack_studio"
$env:PETPACK_REHEARSAL_POSTGRES_CA_FILE = $caFile
$stdoutPath = Join-Path $controlRoot "verifier.stdout.log"
$stderrPath = Join-Path $controlRoot "verifier.stderr.log"
$serverLog = Join-Path $controlRoot "postgres-restart.log"
$readyPath = Join-Path $controlRoot "ready.json"
$outagePath = Join-Path $controlRoot "outage-observed.json"
$nodeReportPath = Join-Path $controlRoot "node-report.json"

$serverStarted = $false
$verifier = $null
try {
  Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start", "-D", $dataDir, "-l", $serverLog, "-w", "-t", "30")
  $serverStarted = $true
  $verifier = Start-Process -FilePath $nodeExe -ArgumentList @($verifierScript) -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  Wait-ForFile -Path $readyPath -Process $verifier -TimeoutSeconds 45
  Invoke-CheckedNative -FilePath $pgCtl -Arguments @("stop", "-D", $dataDir, "-m", "fast", "-w", "-t", "30")
  $serverStarted = $false
  Wait-ForFile -Path $outagePath -Process $verifier -TimeoutSeconds 45
  Invoke-CheckedNative -FilePath $pgCtl -Arguments @("start", "-D", $dataDir, "-l", $serverLog, "-w", "-t", "30")
  $serverStarted = $true

  if (-not $verifier.WaitForExit(60000)) {
    throw "PostgreSQL outage verifier did not finish after the server recovered"
  }
  $verifier.Refresh()
  if ($verifier.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $nodeReportPath -PathType Leaf)) {
    throw "PostgreSQL outage verifier failed; inspect the retained logs under $controlRoot"
  }

  $nodeReport = Get-Content -LiteralPath $nodeReportPath -Raw | ConvertFrom-Json
  $report = [ordered]@{
    schemaVersion = "petpack-local-postgres-outage-rehearsal/v1"
    runRoot = $runRoot
    controlRoot = $controlRoot
    postgresVersion = [string]$tlsReport.postgresVersion
    port = $port
    tls = $nodeReport.before
    outage = $nodeReport.outage
    recovery = $nodeReport.recovered
    businessAttemptsConsumed = [int]$nodeReport.businessAttemptsConsumed
    externalProviderCallCount = [int]$nodeReport.externalProviderCallCount
    exactPgCtlStopStartUsed = $true
    dockerMutationUsed = $false
    hostPathDeleted = $false
    retainedForAudit = $true
  }
  $reportPath = Join-Path $controlRoot "report.json"
  Write-Utf8NoBom -Path $reportPath -Content (($report | ConvertTo-Json -Depth 8) + "`n")
  Write-Output "POSTGRES_OUTAGE_REHEARSAL_OK=$reportPath"
} finally {
  if ($verifier -and -not $verifier.HasExited) {
    try {
      Stop-OwnedChildProcess -Process $verifier -Label "PostgreSQL outage verifier"
    } catch {
      Write-Warning "The owned verifier process did not stop cleanly; inspect $controlRoot"
    }
  }
  if ($serverStarted) {
    & $pgCtl stop -D $dataDir -m fast -w -t 30 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "The isolated PostgreSQL process did not stop cleanly; inspect $runRoot"
    }
  }
  $env:PETPACK_REHEARSAL_POSTGRES_URL = $null
  $env:PETPACK_REHEARSAL_POSTGRES_CA_FILE = $null
  $env:PETPACK_REHEARSAL_CONTROL_ROOT = $null
}
