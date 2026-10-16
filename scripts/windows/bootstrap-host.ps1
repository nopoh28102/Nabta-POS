param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$TaskName = "NabtaPOSServer"
)

$ErrorActionPreference = "Stop"
$programData = Join-Path $env:ProgramData "Nabta"
$serverData = Join-Path $programData "server"
$dataDir = Join-Path $programData "data\pglite"
$backupDir = Join-Path $programData "backups"
$installLog = Join-Path $programData "install.log"
New-Item -ItemType Directory -Force -Path $serverData, $dataDir, $backupDir | Out-Null
function Write-InstallLog([string]$message) {
  "$(Get-Date -Format o) $message" | Add-Content -LiteralPath $installLog -Encoding UTF8
}
Write-InstallLog "Nabta host bootstrap started. InstallRoot=$InstallRoot"
$secretPath = Join-Path $serverData "server-secrets.json"
$pfxPath = Join-Path $serverData "server.pfx"

if (-not (Test-Path -LiteralPath $secretPath) -or -not (Test-Path -LiteralPath $pfxPath)) {
  $setupToken = [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
  $pfxPassword = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
  $securePassword = ConvertTo-SecureString $pfxPassword -AsPlainText -Force
  $dnsNames = @("localhost", $env:COMPUTERNAME)
  $certificate = New-SelfSignedCertificate -DnsName $dnsNames -CertStoreLocation "Cert:\LocalMachine\My" -KeyExportPolicy Exportable -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5)
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
  $fingerprint = $certificate.Thumbprint
  @{ setupToken = $setupToken; pfxPassword = $pfxPassword; fingerprint = $fingerprint } | ConvertTo-Json | Set-Content -LiteralPath $secretPath -Encoding UTF8
  Remove-Item "Cert:\LocalMachine\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
  Write-InstallLog "Generated local TLS certificate."
}

# Keep the generated credentials readable only by the service account and local administrators.
& icacls.exe $serverData /inheritance:r /grant:r "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)" | Out-Null

# The installer owns these two narrowly scoped LAN rules; no public-network exposure is created.
try {
  Get-NetFirewallRule -DisplayName "Nabta POS API" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName "Nabta POS Discovery" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "Nabta POS API" -Direction Inbound -Protocol TCP -LocalPort 7443 -Action Allow -Profile Domain,Private | Out-Null
  New-NetFirewallRule -DisplayName "Nabta POS Discovery" -Direction Inbound -Protocol UDP -LocalPort 47620 -Action Allow -Profile Domain,Private | Out-Null
  Write-InstallLog "LAN firewall rules configured."
} catch {
  Write-InstallLog "Firewall setup warning: $($_.Exception.Message)"
}

$exe = Get-ChildItem -LiteralPath $InstallRoot -Filter "*.exe" | Where-Object { $_.Name -notlike "*uninstaller*" } | Select-Object -First 1
if (-not $exe) { throw "Nabta executable was not found in $InstallRoot" }
$oldService = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
if ($oldService) {
  Stop-Service -Name $TaskName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $TaskName | Out-Null
  Start-Sleep -Seconds 1
}
try {
  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  $action = New-ScheduledTaskAction -Execute $exe.FullName -Argument "--run-server"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description "Nabta local server and embedded database" -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-InstallLog "Windows scheduled task $TaskName created and started for $env:USERDOMAIN\$env:USERNAME."
} catch {
  Write-InstallLog "HOST TASK SETUP FAILED: $($_.Exception.Message)"
  throw
}
