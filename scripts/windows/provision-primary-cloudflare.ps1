param([Parameter(Mandatory = $true)][string]$InstallRoot)

$ErrorActionPreference = "Stop"
$bootstrap = Join-Path $InstallRoot "resources\primary-bootstrap\cloudflare-provisioning.json"
if (-not (Test-Path -LiteralPath $bootstrap)) { exit 0 }

$settings = Get-Content -LiteralPath $bootstrap -Raw | ConvertFrom-Json
if (-not $settings.enabled -or [string]::IsNullOrWhiteSpace($settings.tunnelToken) -or [string]::IsNullOrWhiteSpace($settings.commerceSharedSecret)) {
  throw "Primary Cloudflare provisioning is incomplete."
}

# Electron's per-user local data location.  The installer runs under the user
# who chose the installation, so no shared Cloudflare token is left in ProgramData.
$runtime = Join-Path $env:APPDATA "@nabta\desktop\local-data\runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$target = Join-Path $runtime "cloudflare-connection.json"
$settings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $target -Encoding UTF8
& icacls.exe $target /inheritance:r /grant:r "$env:USERNAME:(R,W)" "Administrators:(F)" "SYSTEM:(F)" | Out-Null

# Do not leave the setup token in Program Files after successful provisioning.
Remove-Item -LiteralPath $bootstrap -Force
