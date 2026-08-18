# Vorion Tracker - Windows installer
# For IT teams deploying via GPO, SCCM, or Intune.

param(
    [string]$ServerUrl = "https://api.vorionsystems.com",
    [switch]$Silent,
    [switch]$Uninstall,
    [switch]$SkipDeviceCheck
)

$ErrorActionPreference = "Stop"
$AgentName = "Vorion Tracker"
$DownloadUrl = "$ServerUrl/api/agent/download?platform=win"
$TempFile = "$env:TEMP\Vorion-Tracker-Setup.exe"
$DeviceCheckUrl = "$ServerUrl/api/agent/device-check"
$CleanupScript = Join-Path $PSScriptRoot "clean-windows-install.ps1"

function Invoke-VorionCleanup {
    if (Test-Path -LiteralPath $CleanupScript) {
        powershell -ExecutionPolicy Bypass -File $CleanupScript -RemoveData
        return
    }

    Get-Process -Name "Vorion Tracker","VorionTracker","vorion-tracker" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    schtasks /Delete /F /TN "VorionTrackerWatchdog" 2>$null | Out-Null
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "VorionTracker" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "VorionTrackerUI" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:ProgramData\VorionTracker" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:LOCALAPPDATA\Programs\Vorion Tracker" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:LOCALAPPDATA\Vorion Tracker" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:LOCALAPPDATA\vorion-tracker-updater" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$env:APPDATA\Vorion Tracker" -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Uninstall) {
    Write-Host "Uninstalling $AgentName..." -ForegroundColor Yellow
    Invoke-VorionCleanup
    Write-Host "Uninstalled and cleaned all Vorion Tracker files." -ForegroundColor Green
    exit 0
}

$installed = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    Get-ItemProperty -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $AgentName }

if ($installed -and -not $Silent) {
    Write-Host "$AgentName is already installed. Cleaning old install first..." -ForegroundColor Yellow
}

if (-not $SkipDeviceCheck) {
    if (-not $Silent) { Write-Host "[0/4] Verifying this is a company-managed device..." -ForegroundColor Cyan }
    try {
        $devicePayload = @{
            hostname = $env:COMPUTERNAME
            platform = "win32"
            installScope = "user-install"
        } | ConvertTo-Json
        $deviceCheck = Invoke-RestMethod -Uri $DeviceCheckUrl -Method Post -ContentType "application/json" -Body $devicePayload
        if (-not $deviceCheck.allowed) {
            $blockedReason = if ($deviceCheck.reason) { $deviceCheck.reason } else { "Install blocked on this device." }
            Write-Host $blockedReason -ForegroundColor Red
            exit 1
        }
    } catch {
        Write-Host "Device verification failed: $_" -ForegroundColor Red
        exit 1
    }
}

if (-not $Silent) { Write-Host "[1/4] Downloading $AgentName from $ServerUrl..." -ForegroundColor Cyan }
try {
    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "VorionTracker-Installer/1.0")
    $webClient.DownloadFile($DownloadUrl, $TempFile)
} catch {
    Write-Host "Download failed: $_" -ForegroundColor Red
    exit 1
}

if (-not $Silent) { Write-Host "[2/4] Removing previous install and data..." -ForegroundColor Cyan }
Invoke-VorionCleanup

if (-not $Silent) { Write-Host "[3/4] Installing..." -ForegroundColor Cyan }
$installArgs = if ($Silent) { "/S /SERVERURL=$ServerUrl" } else { "/SERVERURL=$ServerUrl" }
$proc = Start-Process -FilePath $TempFile -ArgumentList $installArgs -Wait -PassThru
Remove-Item $TempFile -Force -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    Write-Host "Installation failed with exit code $($proc.ExitCode)" -ForegroundColor Red
    exit $proc.ExitCode
}

if (-not $Silent) { Write-Host "[4/4] Configuring auto-start..." -ForegroundColor Cyan }
$appPath = "$env:LOCALAPPDATA\Programs\Vorion Tracker\Vorion Tracker.exe"
if (Test-Path -LiteralPath $appPath) {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
        -Name "VorionTracker" -Value "`"$appPath`"" -ErrorAction SilentlyContinue
    schtasks /Create /F /SC MINUTE /MO 1 /TN "VorionTrackerWatchdog" /TR "`"$appPath`"" | Out-Null
}

if (-not $Silent) {
    Write-Host ""
    Write-Host "Vorion Tracker installed cleanly." -ForegroundColor Green
    Write-Host "Look for the icon in your system tray and sign in with your company email."
}

Start-Process $appPath -ErrorAction SilentlyContinue
