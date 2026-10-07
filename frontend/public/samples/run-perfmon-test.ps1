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
  Works with Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [Parameter(Mandatory = $true)][string]$Plan,
  [string[]]$JMeterArgs = @()
)
$ErrorActionPreference = 'Stop'
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
Write-Host "> Running JMeter (live view: $($base -replace ':\d+$', ':3000')/live/$runId) ..."
$argsList = @('-n', '-t', $Plan, '-l', "$out\results.jtl", '-e', '-o', "$out\report", '-j', "$out\jmeter.log",
  "-Jperfmon.url=$base", "-Jperfmon.runId=$runId", "-Jperfmon.token=$($env:PERFMON_API_KEY)") + $JMeterArgs
& $jmeter @argsList
$jm = $LASTEXITCODE

function Send-Artifact([string]$Kind, [string]$File) {
  if (-not (Test-Path $File)) { Write-Host "  (skipped $Kind: $File not found)"; return }
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
