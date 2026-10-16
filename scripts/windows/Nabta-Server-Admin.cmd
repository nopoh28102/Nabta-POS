@echo off
setlocal
set "NABTA_ROOT=%ProgramFiles%\@nabtadesktop"
if not exist "%NABTA_ROOT%" set "NABTA_ROOT=%~dp0win-unpacked"
if not exist "%NABTA_ROOT%" set "NABTA_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:NABTA_ROOT; $p=Get-ChildItem -LiteralPath $root -Filter '*.exe' | Where-Object { $_.Length -gt 10MB -and $_.Name -notmatch '(?i)uninstall|setup|remove' } | Sort-Object Length -Descending | Select-Object -First 1; if(-not $p){ msg.exe $env:USERNAME 'Nabta executable was not found'; exit 2 }; Start-Process -FilePath $p.FullName -ArgumentList '--run-server' -Verb RunAs -WindowStyle Hidden"
if errorlevel 1 msg * "Nabta server could not be started. Approve the administrator prompt."
exit /b 0
