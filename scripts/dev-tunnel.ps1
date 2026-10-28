# Expose the live local dev build (vite :5173 + relay proxy) at https://bitblade-dev.bitbased.net
# One-time:  winget install Cloudflare.cloudflared ; cloudflared tunnel login
# Then run:  powershell -File scripts/dev-tunnel.ps1   (with `bun run dev` and `bun run relay` running)
$ErrorActionPreference = 'Stop'
$name = 'bitblade-dev'
$hostname = 'bitblade-dev.bitbased.net'
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
if (-not (Test-Path $cf)) { throw 'cloudflared not found — winget install Cloudflare.cloudflared' }

$list = & $cf tunnel list --output json | ConvertFrom-Json
$t = $list | Where-Object { $_.name -eq $name }
if (-not $t) {
  & $cf tunnel create $name | Out-Host
  $t = (& $cf tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $name }
}
& $cf tunnel route dns --overwrite-dns $name $hostname | Out-Host

$cfgDir = Join-Path $env:USERPROFILE '.cloudflared'
$cred = Join-Path $cfgDir "$($t.id).json"
$cfg = Join-Path $cfgDir 'bitblade-dev.yml'
@"
tunnel: $($t.id)
credentials-file: $cred
ingress:
  - hostname: $hostname
    service: http://localhost:5173
  - service: http_status:404
"@ | Set-Content -Encoding utf8 $cfg
Write-Host "Tunnel $name -> $hostname -> http://localhost:5173"
& $cf tunnel --config $cfg run $name
