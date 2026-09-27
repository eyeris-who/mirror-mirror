<#
  Start the whole mirror for kiosk use: server (serving the built page), voice
  service, then Chrome full-screen.

    powershell -ExecutionPolicy Bypass -File scripts\start-mirror.ps1

  To run it at login, create a shortcut to that command in your Startup folder
  (Win+R -> shell:startup). Build the page first: npm run build
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3001

if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
  Write-Host 'web/dist missing - building the page first...'
  Push-Location $root; npm run build; Pop-Location
}

function Test-Mirror {
  try { Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 1 | Out-Null; return $true }
  catch { return $false }
}

if (-not (Test-Mirror)) {
  Start-Process -WindowStyle Minimized -WorkingDirectory $root -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Mirror)) {
    if ((Get-Date) -gt $deadline) { throw "server didn't come up on :$port" }
    Start-Sleep -Milliseconds 500
  }
}

Start-Process -WindowStyle Minimized -WorkingDirectory $root -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run voice'

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
  Start-Process -FilePath $chrome -ArgumentList '--kiosk', "--app=http://localhost:$port", '--autoplay-policy=no-user-gesture-required'
} else {
  Write-Warning "Chrome not found - open http://localhost:$port full-screen yourself."
}
