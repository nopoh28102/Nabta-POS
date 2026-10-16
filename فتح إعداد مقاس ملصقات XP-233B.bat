@echo off
setlocal
set "PRINTER_NAME=Xprinter XP-233B"

rem Opens the driver Printing Preferences. Choose Page Setup, then New... to create a label stock.
rundll32.exe printui.dll,PrintUIEntry /e /n "%PRINTER_NAME%"

if errorlevel 1 (
  echo.
  echo لم يتم فتح إعدادات الطابعة. تأكد أن طابعة Xprinter XP-233B مثبتة بالاسم نفسه.
  pause
)
