param([string]$ServiceName = "NabtaPOSServer")
$ErrorActionPreference = "Stop"
& sc.exe stop $ServiceName | Out-Host
& sc.exe delete $ServiceName | Out-Host
Write-Host "Only the server service was removed. Database and backups were not deleted." -ForegroundColor Yellow
