# Restarts the Tisseo Live dev server in the background.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1 [-Port 4127]
# NOTE: ce fichier doit rester ASCII (PowerShell 5.1 lit les .ps1 en ANSI).
param([int]$Port = 4127)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -like '*\nodejs\node.exe' -and $_.CommandLine -like '*server.mjs*' }
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }
Start-Sleep -Milliseconds 400

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
