param(
  [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [string]$NodePath = "node",
  [string]$ServiceName = "NabtaPOSServer"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $InstallRoot).Path
$entry = Join-Path $root "apps\server\dist\index.js"
$envFile = Join-Path $root ".env"
if (-not (Test-Path -LiteralPath $entry)) { throw "Built server was not found: $entry" }
if (-not (Test-Path -LiteralPath $envFile)) { throw "Create .env from .env.example before installing the service: $envFile" }
$node = (Get-Command $NodePath -ErrorAction Stop).Source
$binPath = '"{0}" --env-file="{1}" "{2}"' -f $node, $envFile, $entry

& sc.exe query $ServiceName *> $null
if ($LASTEXITCODE -eq 0) { & sc.exe stop $ServiceName *> $null; & sc.exe delete $ServiceName | Out-Null; Start-Sleep -Seconds 1 }
& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "Nabta POS Server" | Out-Host
& sc.exe description $ServiceName "Nabta POS local server for two tills" | Out-Host
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/""/60000 | Out-Host
Write-Host "Service $ServiceName created. Grant the service account access to DATABASE_DIR and BACKUP_DIR before starting." -ForegroundColor Green
Write-Host "Start with: Start-Service $ServiceName"
