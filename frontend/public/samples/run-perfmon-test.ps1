<#
.SYNOPSIS
  Perfmon wrapper: create a run -> run JMeter with the Perfmon Backend Listener -> upload JTL + HTML report -> complete the run.
.EXAMPLE
  $env:PERFMON_URL="http://perfmon.example.com:8080"; $env:PERFMON_API_KEY="pmk_..."
  $env:PERFMON_PROJECT="payments"; $env:PERFMON_APPLICATION="merchant-payments"
  $env:PERFMON_ENVIRONMENT="Performance"; $env:PERFMON_TEST="200 TPS Payment Load"
  .\run-perfmon-test.ps1 -Plan .\perfmon-sample-test.jmx -JMeterArgs "-Jusers=20","-Jduration=600"
.NOTES
  Optional: $env:PERFMON_BUILD (build number), $env:JMETER (path to jmeter.bat; default: jmeter on PATH).
  Load generator monitoring: the Perfmon Collector (perfmon-collector.mjs next to this script, or $env:PERFMON_COLLECTOR;
  needs Node.js 18+) runs in the background during the test with role "loadgen" and the new Run ID.
  Disable with $env:PERFMON_LOADGEN_MONITOR="false". $env:PERFMON_SERVER sets the load generator name (default: computer name).
  Works with Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [Parameter(Mandatory = $true)][string]$Plan,
  [string[]]$JMeterArgs = @()
)
$ErrorActionPreference = 'Stop'
# 'powershell -File' passes -JMeterArgs "-Ja=1","-Jb=2" as one comma-joined string: split it back into arguments
$JMeterArgs = @($JMeterArgs | ForEach-Object { $_ -split ',(?=-)' } | Where-Object { $_ })
foreach ($v in 'PERFMON_URL', 'PERFMON_API_KEY', 'PERFMON_PROJECT', 'PERFMON_APPLICATION', 'PERFMON_ENVIRONMENT', 'PERFMON_TEST') {
  if (-not [Environment]::GetEnvironmentVariable($v)) { throw "Set the environment variable $v" }
}
$base = $env:PERFMON_URL.TrimEnd('/')
$api = "$base/api/v1"
$headers = @{ authorization = "Bearer $($env:PERFMON_API_KEY)" }
$jmeter = if ($env:JMETER) { $env:JMETER } else { 'jmeter' }

Write-Host "> Checking Perfmon at $base ..."
try { Invoke-RestMethod "$api/health" -TimeoutSec 10 | Out-Null } catch { throw "Perfmon API not reachable at $api/health: $($_.Exception.Message)" }

Write-Host "> Creating run ..."
$body = @{ project = $env:PERFMON_PROJECT; application = $env:PERFMON_APPLICATION; environment = $env:PERFMON_ENVIRONMENT; test = $env:PERFMON_TEST }
if ($env:PERFMON_BUILD) { $body.buildNumber = $env:PERFMON_BUILD }
try {
  $run = Invoke-RestMethod -Method Post "$api/runs" -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json)
} catch {
  $detail = $_.ErrorDetails.Message; throw "Could not create the run: $($_.Exception.Message) $detail"
}
$runId = $run.runId
Write-Host "OK Run ID: $runId"

$out = "perfmon-$runId"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory $out | Out-Null

# Load generator monitoring: host CPU/memory/disk/network + JMeter process and JVM heap, tagged with the Run ID
$collector = if ($env:PERFMON_COLLECTOR) { $env:PERFMON_COLLECTOR } else { Join-Path $PSScriptRoot 'perfmon-collector.mjs' }
$collProc = $null
$collStop = Join-Path (Resolve-Path $out) '.collector-stop'
if ($env:PERFMON_LOADGEN_MONITOR -eq 'false') {
  Write-Host "> Load generator monitoring disabled (PERFMON_LOADGEN_MONITOR=false)"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  (load generator monitoring skipped: Node.js 18+ not found on PATH)"
} elseif (-not (Test-Path $collector)) {
  Write-Host "  (load generator monitoring skipped: $collector not found - download perfmon-collector.mjs next to this script)"
} else {
  $saved = @{}
  $collEnv = @{ PERFMON_RUN_ID = $runId; PERFMON_ROLE = 'loadgen'; PERFMON_JMETER = 'true'; PERFMON_STOP_FILE = $collStop }
  if (-not $env:INTERVAL_SEC) { $collEnv.INTERVAL_SEC = '5' }
  foreach ($k in $collEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $collEnv[$k]) }
  try {
    $collProc = Start-Process -FilePath 'node' -ArgumentList "`"$collector`"" -PassThru -NoNewWindow `
      -RedirectStandardOutput "$out\collector.log" -RedirectStandardError "$out\collector.err.log"
    Write-Host "> Load generator monitoring started (collector pid $($collProc.Id), log $out\collector.log)"
  } catch { Write-Host "  (load generator monitoring could not start: $($_.Exception.Message))" }
  finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
}
function Stop-Collector {
  if (-not $script:collProc) { return }
  New-Item -ItemType File -Force $collStop | Out-Null
  if (-not $script:collProc.WaitForExit(20000)) { Stop-Process -Id $script:collProc.Id -Force -ErrorAction SilentlyContinue }
  $script:collProc = $null
  Write-Host "  OK load generator monitoring stopped"
}
Write-Host "> Running JMeter (live view: $($base -replace ':\d+$', ':3000')/live/$runId) ..."
$argsList = @('-n', '-t', $Plan, '-l', "$out\results.jtl", '-e', '-o', "$out\report", '-j', "$out\jmeter.log",
  "-Jperfmon.url=$base", "-Jperfmon.runId=$runId", "-Jperfmon.token=$($env:PERFMON_API_KEY)") + $JMeterArgs
try {
  & $jmeter @argsList
  $jm = $LASTEXITCODE
} finally { Stop-Collector }

function Send-Artifact([string]$Kind, [string]$File) {
  if (-not (Test-Path $File)) { Write-Host "  (skipped ${Kind}: $File not found)"; return }
  # curl.exe ships with Windows 10+ and handles multipart uploads on every PowerShell version
  $code = & curl.exe -s -o NUL -w '%{http_code}' -H "authorization: Bearer $($env:PERFMON_API_KEY)" -F "kind=$Kind" -F "file=@$File" "$api/runs/$runId/artifacts"
  if ($code -in '200', '201') { Write-Host "  OK uploaded $Kind" } else { Write-Host "  FAILED upload of $Kind (HTTP $code)" }
}
Write-Host "> Uploading results ..."
Send-Artifact 'JTL' "$out\results.jtl"
if (Test-Path "$out\report") { Compress-Archive -Path "$out\report\*" -DestinationPath "$out\report.zip" -Force; Send-Artifact 'HTML_REPORT' "$out\report.zip" }
Send-Artifact 'LOG' "$out\jmeter.log"

if ($jm -eq 0) {
  Invoke-RestMethod -Method Post "$api/runs/$runId/complete" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Host "OK Run completed - analysis started: $($base -replace ':\d+$', ':3000')/runs/$runId"
} else {
  $fail = @{ status = 'FAILED'; reason = "JMeter exited with code $jm" } | ConvertTo-Json
  Invoke-RestMethod -Method Post "$api/runs/$runId/complete" -Headers $headers -ContentType 'application/json' -Body $fail | Out-Null
  Write-Host "JMeter exited with code $jm - run marked FAILED"; exit $jm
}
