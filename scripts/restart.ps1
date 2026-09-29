# Restarts the Tisseo Live dev server in the background.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1 [-Port 4127]
# NOTE: ce fichier doit rester ASCII (PowerShell 5.1 lit les .ps1 en ANSI).
param([int]$Port = 4127)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -like '*\nodejs\node.exe' -and $_.CommandLine -like '*server.mjs*' }
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }

# Attendre que le port soit vraiment libre. Sans cette attente, le nouveau
# serveur part alors que l'ancien tient encore le port : il echoue en silence
# (EADDRINUSE) et c'est l'ancien code, lance il y a des heures, qui continue
# de repondre. C'est arrivE : deux corrections « sans effet » venaient de la.
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  $libre = $true
  try { $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop }
  catch { $c = $null }
  if ($c) { $libre = $false }
  if ($libre) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $libre) {
  "ATTENTION : le port $Port est encore occupe apres arret des processus connus."
  "Relancez a la main si le serveur demarre mal."
}

$out = Join-Path $root 'server.out.log'
$err = Join-Path $root 'server.err.log'
Remove-Item $out, $err -ErrorAction SilentlyContinue
$env:PORT = "$Port"
Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $root `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  try {
    $null = Invoke-WebRequest "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    "OK http://localhost:$Port"
    Get-Content $out
    $e = Get-Content $err -ErrorAction SilentlyContinue
    if ($e) { "ERR:"; $e }
    exit 0
  } catch { }
}
"TIMEOUT - see $err"
Get-Content $err -ErrorAction SilentlyContinue
exit 1
