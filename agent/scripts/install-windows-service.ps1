param(
  [Parameter(Mandatory = $true)][string]$AppExePath,
  [Parameter(Mandatory = $true)][ValidatePattern('^vrt_dev_')][string]$DeviceToken,
  [string]$ServerUrl = "https://api.vorionsystems.com",
  [string]$ServiceName = "VorionTrackerSupervisor"
)
$ErrorActionPreference = "Stop"
$resolvedApp = [System.IO.Path]::GetFullPath($AppExePath)
if (-not (Test-Path -LiteralPath $resolvedApp)) { throw "Agent executable not found: $resolvedApp" }
$supervisor = Join-Path (Split-Path -Parent $resolvedApp) "resources\VorionSupervisor.exe"
if (-not (Test-Path -LiteralPath $supervisor)) { throw "Supervisor executable not found: $supervisor" }
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $supervisor
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.Arguments = "--install --server `"$ServerUrl`" --agent `"$resolvedApp`""
  $startInfo.EnvironmentVariables['VORION_DEVICE_TOKEN'] = $DeviceToken
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $process.WaitForExit()
  $startInfo.EnvironmentVariables.Remove('VORION_DEVICE_TOKEN')
  if ($process.ExitCode -ne 0) { throw "Supervisor install failed with exit code $($process.ExitCode)" }
}
$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne 'Running') { Start-Service -Name $ServiceName; $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(15)) }
Write-Host "$ServiceName is installed and running."
