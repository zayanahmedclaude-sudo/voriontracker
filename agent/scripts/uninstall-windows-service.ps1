param(
  [string]$ServiceName = "VorionTrackerService",
  [switch]$RemoveUiAtLogon = $true,
  [switch]$RemoveData = $true
)

$ErrorActionPreference = "Stop"

$cleanupScript = Join-Path $PSScriptRoot "clean-windows-install.ps1"
if (Test-Path -LiteralPath $cleanupScript) {
  $args = @("-ExecutionPolicy", "Bypass", "-File", $cleanupScript, "-ServiceName", $ServiceName)
  if ($RemoveData) { $args += "-RemoveData" }
  powershell @args
  exit $LASTEXITCODE
}

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
}

if ($RemoveUiAtLogon) {
  Remove-ItemProperty -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "VorionTrackerUI" -ErrorAction SilentlyContinue
}

schtasks /Delete /F /TN "VorionTrackerWatchdog" 2>$null | Out-Null
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "VorionTracker" -ErrorAction SilentlyContinue

if ($RemoveData) {
  Remove-Item -LiteralPath "$env:ProgramData\VorionTracker" -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Removed $ServiceName and Vorion Tracker leftovers"
