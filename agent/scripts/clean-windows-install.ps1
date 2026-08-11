param(
  [string]$ServiceName = "VorionTrackerService",
  [switch]$RemoveData = $true
)

$ErrorActionPreference = "Continue"

$appName = "Vorion Tracker"
$taskName = "VorionTrackerWatchdog"
$runNames = @("VorionTracker", "VorionTrackerUI")
$processNames = @("Vorion Tracker", "VorionTracker", "vorion-tracker")

function Stop-VorionProcesses {
  foreach ($name in $processNames) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}

function Remove-RegistryValueIfExists([string]$path, [string]$name) {
  if (Test-Path -LiteralPath $path) {
    Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue
  }
}

function Invoke-NsisUninstaller {
  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )

  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $entry = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
      Get-ItemProperty -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $appName } |
      Select-Object -First 1

    if ($entry -and $entry.UninstallString) {
      $command = [Environment]::ExpandEnvironmentVariables($entry.UninstallString)
      if ($command.StartsWith('"')) {
        $endQuote = $command.IndexOf('"', 1)
        $exe = $command.Substring(1, $endQuote - 1)
      } else {
        $exe = ($command -split '\s+', 2)[0]
      }
      if (Test-Path -LiteralPath $exe) {
        Start-Process -FilePath $exe -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
      }
    }
  }
}

function Remove-DirectoryIfSafe([string]$path) {
  if (-not $path) { return }
  $resolvedParent = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $resolvedParent)) { return }
  $fullPath = [System.IO.Path]::GetFullPath($path)
  $safeRoots = @(
    [System.IO.Path]::GetFullPath($env:ProgramData),
    [System.IO.Path]::GetFullPath($env:LOCALAPPDATA),
    [System.IO.Path]::GetFullPath($env:APPDATA),
    [System.IO.Path]::GetFullPath($env:TEMP)
  )
  $isSafe = $false
  foreach ($root in $safeRoots) {
    if ($fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $isSafe = $true
      break
    }
  }
  if ($isSafe -and (Test-Path -LiteralPath $fullPath)) {
    Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Stopping Vorion Tracker processes..."
Stop-VorionProcesses

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
  Write-Host "Removing $ServiceName..."
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
}

Write-Host "Removing scheduled tasks and auto-start entries..."
schtasks /Delete /F /TN $taskName 2>$null | Out-Null
foreach ($runName in $runNames) {
  Remove-RegistryValueIfExists "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" $runName
  Remove-RegistryValueIfExists "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" $runName
}

Write-Host "Running registered uninstaller if present..."
Invoke-NsisUninstaller
Stop-VorionProcesses

Write-Host "Removing install directories..."
Remove-DirectoryIfSafe (Join-Path $env:LOCALAPPDATA "Programs\Vorion Tracker")
Remove-DirectoryIfSafe (Join-Path $env:LOCALAPPDATA "Vorion Tracker")
Remove-DirectoryIfSafe (Join-Path $env:LOCALAPPDATA "vorion-tracker-updater")
Remove-DirectoryIfSafe (Join-Path $env:APPDATA "Vorion Tracker")
Remove-DirectoryIfSafe (Join-Path $env:TEMP "Vorion-Tracker-Setup.exe")

if ($RemoveData) {
  Write-Host "Removing shared agent data..."
  Remove-DirectoryIfSafe (Join-Path $env:ProgramData "VorionTracker")
}

Write-Host "Vorion Tracker cleanup complete."
