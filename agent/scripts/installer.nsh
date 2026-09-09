!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
!define VORION_SUPERVISOR_BUILD "${__FILEDIR__}\..\supervisor\publish\VorionSupervisor.exe"
Var VorionDeviceToken
Var VorionServerUrl
Var VorionServerField
Var VorionEmployeeName
Var VorionEmployeeField

!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/DEVICETOKEN=" $VorionDeviceToken
  ${GetOptions} $R0 "/SERVERURL=" $VorionServerUrl
  ${GetOptions} $R0 "/EMPLOYEENAME=" $VorionEmployeeName
  ${If} $VorionDeviceToken == ""
    ReadEnvStr $VorionDeviceToken "VORION_DEVICE_TOKEN"
  ${EndIf}
  ${If} $VorionServerUrl == ""
    StrCpy $VorionServerUrl "https://api.vorionsystems.com"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom VorionEnrollmentPageCreate VorionEnrollmentPageLeave
!macroend

Function VorionEnrollmentPageCreate
  ; Existing enrollment is reused by the elevated upgrade helper.
  ReadRegStr $R0 HKLM "SYSTEM\CurrentControlSet\Services\VorionTrackerSupervisor" "ImagePath"
  ${If} $R0 != ""
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $R0
  ${If} $R0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "Device enrollment"
  Pop $R0
  CreateFont $R1 "$(^Font)" "12" "700"
  SendMessage $R0 ${WM_SETFONT} $R1 1
  ${NSD_CreateLabel} 0 34u 100% 34u "Setup will send this computer to Dashboard > Devices. Ask a Vorion administrator to review it and click Approve."
  Pop $R0
  ${NSD_CreateLabel} 0 74u 100% 12u "Employee name"
  Pop $R0
  ${NSD_CreateText} 0 90u 100% 13u "$VorionEmployeeName"
  Pop $VorionEmployeeField
  ${NSD_CreateLabel} 0 111u 100% 12u "Server URL"
  Pop $R0
  ${NSD_CreateText} 0 127u 100% 13u "$VorionServerUrl"
  Pop $VorionServerField
  ${NSD_CreateLabel} 0 148u 100% 26u "Your name helps the administrator assign the right employee. Setup waits up to 15 minutes for approval."
  Pop $R0
  nsDialogs::Show
FunctionEnd

Function VorionEnrollmentPageLeave
  ${NSD_GetText} $VorionEmployeeField $VorionEmployeeName
  ${NSD_GetText} $VorionServerField $VorionServerUrl
  ${If} $VorionEmployeeName == ""
    MessageBox MB_ICONEXCLAMATION "Enter the employee name for this computer."
    Abort
  ${EndIf}
  ${If} $VorionServerUrl == ""
    MessageBox MB_ICONEXCLAMATION "Enter the Vorion server URL. For local testing use http://localhost:3000."
    Abort
  ${EndIf}
FunctionEnd

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\VorionSupervisor-update.exe "${VORION_SUPERVISOR_BUILD}"
  nsExec::ExecToStack /TIMEOUT=120000 '"$PLUGINSDIR\VorionSupervisor-update.exe" --backup-update --agent "$INSTDIR\Vorion Tracker.exe"'
  Pop $R2
  Pop $R5
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Could not safely prepare Vorion Tracker for upgrade:$\r$\n$R5"
    Abort
  ${EndIf}
!macroend

; Never report an upgrade as successful when the previous uninstaller failed
; to launch. electron-builder's default handler logs that error and continues.
!macro VorionRequireOldUninstallSuccess
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Setup could not run the previous Vorion uninstaller. Sign in as the employee who installed it and retry the upgrade. Device registration has been backed up."
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $R0 != 0
    MessageBox MB_ICONSTOP "The previous Vorion version could not be removed (exit code $R0). Close the old tracker and retry setup."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro VorionRequireOldUninstallSuccess
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro VorionRequireOldUninstallSuccess
!macroend

!macro customInstall
  ; Trust Vorion's self-signed public certificate for this managed computer.
  ; Root establishes the self-signed chain; TrustedPublisher authorizes the signer.
  nsExec::ExecToStack '"$SYSDIR\certutil.exe" -addstore -f "Root" "$INSTDIR\resources\VorionPublic.cer"'
  Pop $R2
  Pop $R5
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Could not install the Vorion root certificate:$\r$\n$R5"
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\certutil.exe" -addstore -f "TrustedPublisher" "$INSTDIR\resources\VorionPublic.cer"'
  Pop $R2
  Pop $R5
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Could not trust the Vorion software publisher:$\r$\n$R5"
    Abort
  ${EndIf}
  ${If} $VorionDeviceToken != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "VORION_DEVICE_TOKEN", t "$VorionDeviceToken") i .R4'
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=900000 '"$INSTDIR\resources\VorionSupervisor.exe" --install --server "$VorionServerUrl" --employee-name "$VorionEmployeeName" --agent "$INSTDIR\Vorion Tracker.exe"'
  Pop $R2
  Pop $R5
  System::Call 'Kernel32::SetEnvironmentVariable(t "VORION_DEVICE_TOKEN", i 0) i .R4'
  StrCpy $VorionDeviceToken ""
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Vorion supervisor installation failed:$\r$\n$R5"
    Abort
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\Vorion Tracker"
  CreateShortCut "$SMPROGRAMS\Vorion Tracker\Stop Vorion Tracker.lnk" "$INSTDIR\resources\VorionSupervisor.exe" "--stop"
!macroend
!endif

!macro customUnInstall
  Delete "$SMPROGRAMS\Vorion Tracker\Stop Vorion Tracker.lnk"
  RMDir "$SMPROGRAMS\Vorion Tracker"
  ${If} ${isUpdated}
    ; Preserve enrollment and pending screenshots when replacing agent binaries.
    ExecWait '"$INSTDIR\resources\VorionSupervisor.exe" --prepare-update' $R2
  ${Else}
    ExecWait '"$INSTDIR\resources\VorionSupervisor.exe" --uninstall-elevated' $R2
  ${EndIf}
!macroend
