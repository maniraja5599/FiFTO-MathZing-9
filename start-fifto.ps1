$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Stop-PortProcess([int]$Port) {
  $listeners = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $Port }
  foreach ($listener in $listeners) {
    try { Stop-Process -Id $listener.OwningProcess -Force } catch {}
  }
}

Stop-PortProcess 3001
Stop-PortProcess 8008

Remove-Item dev-server.out.log,dev-server.err.log,vite.out.log,vite.err.log -Force

Start-Process -FilePath node `
  -ArgumentList 'angel-server.mjs' `
  -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $root 'dev-server.out.log') `
  -RedirectStandardError (Join-Path $root 'dev-server.err.log') `
  -WindowStyle Hidden

Start-Sleep -Seconds 3

Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c','npx vite --host 0.0.0.0 --port 8008' `
  -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $root 'vite.out.log') `
  -RedirectStandardError (Join-Path $root 'vite.err.log') `
  -WindowStyle Hidden
