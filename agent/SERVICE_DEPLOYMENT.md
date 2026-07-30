# Vorion Tracker Service Deployment

This setup uses one packaged executable in two modes:

- `Vorion Tracker.exe`
  Runs the desktop UI for logged-in employees.
- `Vorion Tracker.exe --service`
  Runs the background monitoring service at Windows startup.

## What the installer script configures

- Creates `VorionTrackerService` as an auto-start Windows service
- Runs the service as `LocalSystem`
- Configures service recovery to restart after failures
- Uses delayed auto-start
- Shares state in `C:\ProgramData\VorionTracker`
- Registers the UI in `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`

## Install

Run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-service.ps1 -AppExePath "C:\Program Files\Vorion Tracker\Vorion Tracker.exe"
```

## Uninstall

Run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows-service.ps1
```

## Operational notes

- Standard users should not be able to stop the service; Windows will require admin credentials for service-control actions.
- The tray UI can be closed or killed without stopping background monitoring.
- Both UI and service now use the shared machine data path in `C:\ProgramData\VorionTracker`.
- Auto-updates should be handled carefully in service deployments; the UI updater remains enabled, but the service process itself does not run updater scheduling.
