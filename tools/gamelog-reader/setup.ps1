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
  # Ask a candidate for its version; judge only by what it prints (exit codes are
  # unreliable here), and log every attempt to setup.log.
  function Probe($exe, $extra) {
    $ErrorActionPreference = 'Continue'
    $out = ''
    try { $out = (& $exe @extra -c "import sys;print('PYVER', sys.version_info[0]*100+sys.version_info[1])" 2>&1 | Out-String) } catch { $out = $_.Exception.Message }
    $ErrorActionPreference = 'Stop'
    Write-Host "  tried $exe $($extra -join ' '): $($out.Trim())"
    if ($out -match 'PYVER (\d+)' -and [int]$Matches[1] -ge 309) { return $true }
    return $false
  }
  $cands = @()
  foreach ($d in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")) {
    if ($d -and (Test-Path $d)) { Get-ChildItem -Path $d -Filter 'Python3*' -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { $cands += ,@((Join-Path $_.FullName 'python.exe')) } }
  }
  $cands += ,@('py', '-3')
  foreach ($launcher in @("$env:LOCALAPPDATA\Programs\Python\Launcher\py.exe", "$env:WINDIR\py.exe")) { $cands += ,@($launcher, '-3') }
  $cands += ,@('python')
  foreach ($c in $cands) {
    $exe = $c[0]; $extra = @($c | Select-Object -Skip 1)
    if ($exe -like '*\*') { if (-not (Test-Path $exe)) { continue } }
    elseif (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    if (Probe $exe $extra) { $py = $exe; $pyArgs = $extra; break }
  }
  if (-not $py) {
    Write-Host "Python isn't installed (or is older than 3.9). Installing Python 3.12 with winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "Python isn't installed and winget isn't available. Install Python 3.12 from python.org (tick 'Add python.exe to PATH'), then run setup.bat again." }
    $ErrorActionPreference = 'Continue'
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    # -1978335189 = winget says it's already installed, yet no working python.exe was found above
    if ($code -eq -1978335189) { Fail "winget says Python 3.12 is installed, but setup can't find python.exe. In Settings > Apps > Installed apps, find Python 3.12 > Modify > Repair (or install it from python.org with 'Add python.exe to PATH' ticked), then run setup.bat again." }
    if ($code -ne 0) { Fail "winget couldn't install Python (code $code). Install Python 3.12 from python.org (tick 'Add python.exe to PATH'), then run setup.bat again." }
    Write-Host ""
    Write-Host "Python is installed. Close this window and run setup.bat again so Windows picks it up." -ForegroundColor Yellow
    Stop-Transcript | Out-Null
    exit 0
  }
  Write-Host "Using: $(& $py @pyArgs -c 'import sys;print(sys.executable)')"

  Step "Installing the two libraries it needs (lz4, cryptography)"
  $ErrorActionPreference = 'Continue'
  & $py @pyArgs -m pip install --user --quiet --disable-pip-version-check lz4 cryptography
  $code = $LASTEXITCODE; $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { Fail "pip couldn't install lz4 and cryptography." }

  Step "Worker URL and sync secret"
  if (-not (Test-Path 'gamelog-reader.json')) {
    Copy-Item 'gamelog-reader.example.json' 'gamelog-reader.json'
    Write-Host "Notepad is opening. Paste your Worker URL and sync secret (both on Game Log's Sync page), save, and close Notepad."
    Start-Process notepad.exe 'gamelog-reader.json' -Wait
  }
  $cfg = Get-Content 'gamelog-reader.json' -Raw | ConvertFrom-Json
  if (-not $cfg.url -or $cfg.url -like '*YOUR-SUBDOMAIN*') { Fail "gamelog-reader.json still has the example Worker URL. Open it, fill it in, and run setup.bat again." }

  Step "First read of your save"
  $ErrorActionPreference = 'Continue'
  & $py @pyArgs gamelog_reader.py --once
  $code = $LASTEXITCODE; $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { Fail "the first read failed (see the message above)." }

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
