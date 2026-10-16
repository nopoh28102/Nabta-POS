!include LogicLib.nsh

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop NabtaPOSServer'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete NabtaPOSServer'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName ''NabtaPOSServer'' -Confirm:$$false -ErrorAction SilentlyContinue"'
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-NetFirewallRule -DisplayName ''Nabta POS API'',''Nabta POS Discovery'' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"'
!macroend
