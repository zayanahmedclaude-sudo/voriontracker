param(
  [string]$ServiceName = "VorionTrackerService",
  [switch]$RemoveUiAtLogon = $true
)

$ErrorActionPreference = "Stop"

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existingService) {
  Write-Host "$ServiceName is not installed"
  exit 0
}

sc.exe stop $ServiceName | Out-Null
Start-Sleep -Seconds 2
sc.exe delete $ServiceName | Out-Null

if ($RemoveUiAtLogon) {
  $runKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
  Remove-ItemProperty -Path $runKey -Name "VorionTrackerUI" -ErrorAction SilentlyContinue
}

Write-Host "Removed $ServiceName"
