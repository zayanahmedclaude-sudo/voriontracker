param(
  [Parameter(Mandatory = $true)]
  [string]$AppExePath,
  [string]$ServiceName = "VorionTrackerService",
  [string]$DisplayName = "Vorion Tracker Service",
  [switch]$RegisterUiAtLogon = $true
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $AppExePath)) {
  throw "App executable not found: $AppExePath"
}

$programDataRoot = Join-Path $env:ProgramData "VorionTracker"
if (-not (Test-Path -LiteralPath $programDataRoot)) {
  New-Item -ItemType Directory -Path $programDataRoot | Out-Null
}

# Let the desktop UI and the service share state in ProgramData instead of
# per-user AppData so the service can resume sessions after boot. Users get
# modify on the data folder only; service control still stays admin-only.
cmd /c "icacls `"$programDataRoot`" /inheritance:e" | Out-Null
cmd /c "icacls `"$programDataRoot`" /grant *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)M /T /C" | Out-Null

$serviceBinPath = "`"$AppExePath`" --service"
$serviceStartName = "LocalSystem"

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
  sc.exe stop $ServiceName | Out-Null
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

sc.exe create $ServiceName binPath= $serviceBinPath start= auto obj= $serviceStartName DisplayName= $DisplayName | Out-Null
sc.exe description $ServiceName "Background monitoring service for Vorion Tracker." | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/30000 | Out-Null
sc.exe failureflag $ServiceName 1 | Out-Null
sc.exe config $ServiceName start= delayed-auto | Out-Null

if ($RegisterUiAtLogon) {
  $runKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
  Set-ItemProperty -Path $runKey -Name "VorionTrackerUI" -Value "`"$AppExePath`""
}

sc.exe start $ServiceName | Out-Null

Write-Host "Installed and started $ServiceName"
if ($RegisterUiAtLogon) {
  Write-Host "Registered Vorion Tracker UI at machine logon"
}
