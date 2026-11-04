# Game Log save reader setup. Safe to run again.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
Start-Transcript -Path (Join-Path $here 'setup.log') -Force | Out-Null

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host "SETUP STOPPED: $t" -ForegroundColor Red; Write-Host "Details are in $here\setup.log"; Stop-Transcript | Out-Null; exit 1 }

try {
  if ($here -like "$env:TEMP*") { Fail "setup is running from inside the zip. Right-click the zip > Extract All, then run setup.bat from the extracted folder." }

  Step "Finding Python"
  # The Microsoft Store 'python' shortcut exists even when Python isn't installed,
  # so only accept a Python that actually runs.
  $py = $null; $pyArgs = @()
  foreach ($c in @(@('py', '-3'), @('python'))) {
    if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
    $a = @($c | Select-Object -Skip 1)
    $v = & $c[0] @a -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])" 2>$null
    if ($LASTEXITCODE -eq 0 -and [int]"0$v" -ge 309) { $py = $c[0]; $pyArgs = $a; break }
  }
  if (-not $py) {
    Write-Host "Python isn't installed (or is older than 3.9). Installing Python 3.12 with winget..."
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    Fail "Python was just installed. Close this window and run setup.bat again so Windows picks it up."
  }
  Write-Host "Using: $(& $py @pyArgs -c 'import sys;print(sys.executable)')"

  Step "Installing the two libraries it needs (lz4, cryptography)"
  & $py @pyArgs -m pip install --user --quiet --disable-pip-version-check lz4 cryptography
  if ($LASTEXITCODE -ne 0) { Fail "pip couldn't install lz4 and cryptography." }

  Step "Worker URL and sync secret"
  if (-not (Test-Path 'gamelog-reader.json')) {
    Copy-Item 'gamelog-reader.example.json' 'gamelog-reader.json'
    Write-Host "Notepad is opening. Paste your Worker URL and sync secret (both on Game Log's Sync page), save, and close Notepad."
    Start-Process notepad.exe 'gamelog-reader.json' -Wait
  }
  $cfg = Get-Content 'gamelog-reader.json' -Raw | ConvertFrom-Json
  if (-not $cfg.url -or $cfg.url -like '*YOUR-SUBDOMAIN*') { Fail "gamelog-reader.json still has the example Worker URL. Open it, fill it in, and run setup.bat again." }

  Step "First read of your save"
  & $py @pyArgs gamelog_reader.py --once
  if ($LASTEXITCODE -ne 0) { Fail "the first read failed (see the message above)." }

  Step "Starting it in the background, and with Windows"
  $pyw = (& $py @pyArgs -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))").Trim()
  if (-not (Test-Path $pyw)) { Fail "couldn't find pythonw.exe at $pyw" }
  $script = Join-Path $here 'gamelog_reader.py'
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Game Log reader.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $pyw; $s.Arguments = "`"$script`""; $s.WorkingDirectory = $here; $s.Save()
  Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like '*gamelog_reader.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Process $pyw -ArgumentList "`"$script`"" -WorkingDirectory $here

  Write-Host ""
  Write-Host "ALL SET. It's running now and starts with Windows." -ForegroundColor Green
  Write-Host "Open Crimson Desert in Game Log > Goals: you should see 'From your save'."
  Write-Host "Log: $here\gamelog-reader.log"
  Stop-Transcript | Out-Null
} catch {
  Fail $_.Exception.Message
}
