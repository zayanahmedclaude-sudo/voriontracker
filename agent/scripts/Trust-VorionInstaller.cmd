@echo off
setlocal
title Trust Vorion Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Trust-VorionInstaller.ps1" "%~dp0VorionTrackerSetup.exe"
set "VORION_EXIT=%ERRORLEVEL%"
if not "%VORION_EXIT%"=="0" (
  echo.
  echo Certificate installation failed with exit code %VORION_EXIT%.
  pause
)
exit /b %VORION_EXIT%
