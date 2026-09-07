!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var VorionDeviceToken
Var VorionServerUrl
Var VorionServerField

!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/DEVICETOKEN=" $VorionDeviceToken
  ${GetOptions} $R0 "/SERVERURL=" $VorionServerUrl
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
  ${NSD_CreateLabel} 0 76u 100% 12u "Server URL"
  Pop $R0
  ${NSD_CreateText} 0 92u 100% 13u "$VorionServerUrl"
  Pop $VorionServerField
  ${NSD_CreateLabel} 0 114u 100% 26u "Setup waits up to 15 minutes for approval. Production uses the default URL; local testing can use http://localhost:3000."
  Pop $R0
  nsDialogs::Show
FunctionEnd

Function VorionEnrollmentPageLeave
  ${NSD_GetText} $VorionServerField $VorionServerUrl
  ${If} $VorionServerUrl == ""
    MessageBox MB_ICONEXCLAMATION "Enter the Vorion server URL. For local testing use http://localhost:3000."
    Abort
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} $VorionDeviceToken != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "VORION_DEVICE_TOKEN", t "$VorionDeviceToken") i .R4'
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=900000 '"$INSTDIR\resources\VorionSupervisor.exe" --install --server "$VorionServerUrl" --agent "$INSTDIR\Vorion Tracker.exe"'
  Pop $R2
  Pop $R5
  System::Call 'Kernel32::SetEnvironmentVariable(t "VORION_DEVICE_TOKEN", i 0) i .R4'
  StrCpy $VorionDeviceToken ""
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Vorion supervisor installation failed:$\r$\n$R5"
    Abort
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  ExecWait '"$INSTDIR\resources\VorionSupervisor.exe" --uninstall-elevated' $R2
!macroend
