# Vorion Tracker — Windows Silent Installer
# For IT teams deploying via GPO, SCCM, or Intune
# Run as: powershell -ExecutionPolicy Bypass -File install-windows.ps1
# Or silently: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File install-windows.ps1

param(
    [string]$ServerUrl = "https://your-app.vercel.app",
    [switch]$Silent,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$AgentName   = "Vorion Tracker"
$DownloadUrl = "$ServerUrl/api/agent/download?platform=win"
$TempFile    = "$env:TEMP\Vorion-Tracker-Setup.exe"

# ── Uninstall ───────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "Uninstalling $AgentName..." -ForegroundColor Yellow
    $uninstKey = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq $AgentName } | Select-Object -First 1
    if ($uninstKey) {
        Start-Process $uninstKey.UninstallString -ArgumentList "/S" -Wait
        Write-Host "✓ Uninstalled" -ForegroundColor Green
    } else {
        Write-Host "Vorion Tracker not found" -ForegroundColor Red
    }
    exit
}

# ── Check if already installed ──────────────────────────────────────────────
$installed = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    Get-ItemProperty | Where-Object { $_.DisplayName -eq $AgentName }

if ($installed -and -not $Silent) {
    Write-Host "$AgentName is already installed. Reinstalling..." -ForegroundColor Yellow
}

# ── Download ─────────────────────────────────────────────────────────────────
if (-not $Silent) { Write-Host "[1/3] Downloading $AgentName from $ServerUrl..." -ForegroundColor Cyan }

try {
    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "VorionTracker-Installer/1.0")
    $webClient.DownloadFile($DownloadUrl, $TempFile)
} catch {
    Write-Host "Download failed: $_" -ForegroundColor Red
    exit 1
}

# ── Install ──────────────────────────────────────────────────────────────────
if (-not $Silent) { Write-Host "[2/3] Installing..." -ForegroundColor Cyan }
$installArgs = if ($Silent) { "/S /SERVERURL=$ServerUrl" } else { "/SERVERURL=$ServerUrl" }
$proc = Start-Process -FilePath $TempFile -ArgumentList $installArgs -Wait -PassThru
Remove-Item $TempFile -Force -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    Write-Host "Installation failed with exit code $($proc.ExitCode)" -ForegroundColor Red
    exit $proc.ExitCode
}

# ── Configure auto-start (registry) ─────────────────────────────────────────
if (-not $Silent) { Write-Host "[3/3] Configuring auto-start..." -ForegroundColor Cyan }
$appPath = "$env:LOCALAPPDATA\Programs\Vorion Tracker\Vorion Tracker.exe"
if (Test-Path $appPath) {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
        -Name "VorionTracker" -Value "`"$appPath`"" -ErrorAction SilentlyContinue
}

if (-not $Silent) {
    Write-Host ""
    Write-Host "✅ Vorion Tracker installed!" -ForegroundColor Green
    Write-Host "   Look for the icon in your system tray (bottom-right)."
    Write-Host "   Sign in with your company email to start tracking."
}

# Launch the app
Start-Process $appPath -ErrorAction SilentlyContinue
