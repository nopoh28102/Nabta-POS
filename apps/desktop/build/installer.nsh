!include LogicLib.nsh

; The local POS data is user-scoped and intentionally survives application
; updates.  Create a durable snapshot when an existing installation is being
; removed, and run the same hook after a first upgrade as a compatibility
; fallback for installations whose old uninstaller did not contain this hook.
!macro NabtaCreatePreInstallBackup
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer-tools\create-preinstall-backup.ps1" -AppDataPath "$APPDATA" -DocumentsPath "$DOCUMENTS"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Nabta data backup failed: $1"
    MessageBox MB_ICONSTOP|MB_OK "Nabta could not create the required data backup. The update/uninstall was stopped to protect your data.$\r$\n$\r$\nDetails: $1"
    Abort
  ${EndIf}
!macroend

; A normal Nabta installer has no cloud credentials.  A one-device primary
; installer contains a short-lived provisioning file generated outside Git.
; This runs after files are copied and safely becomes a no-op for normal builds.
!macro customInstall
  !insertmacro NabtaCreatePreInstallBackup
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\primary-bootstrap\provision-primary-cloudflare.ps1" -InstallRoot "$INSTDIR"'
!macroend

!macro customUnInstall
  !insertmacro NabtaCreatePreInstallBackup
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop NabtaPOSServer'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete NabtaPOSServer'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName ''NabtaPOSServer'' -Confirm:$$false -ErrorAction SilentlyContinue"'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-NetFirewallRule -DisplayName ''Nabta POS API'',''Nabta POS Discovery'' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"'
!macroend
