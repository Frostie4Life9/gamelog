# Game Log save reader setup. Safe to run again.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# 1. Python
$py = $null
foreach ($c in @('py', 'python')) { if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break } }
if (-not $py) {
  Write-Host "Python isn't installed. Installing Python 3.12 with winget..."
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  Write-Host "Done. Close this window and run setup.bat again so Windows picks up Python."
  Read-Host 'Press Enter to close'; exit 1
}
$pyArgs = @(); if ($py -eq 'py') { $pyArgs = @('-3') }

# 2. Libraries (decryption and decompression)
& $py @pyArgs -m pip install --user --quiet --disable-pip-version-check lz4 cryptography

# 3. Config: Worker URL + sync secret
if (-not (Test-Path 'gamelog-reader.json')) {
  Copy-Item 'gamelog-reader.example.json' 'gamelog-reader.json'
  Write-Host "Fill in your Worker URL and sync secret (both are on Game Log's Sync page), save, and close Notepad."
  Start-Process notepad.exe 'gamelog-reader.json' -Wait
}

# 4. First read, so you see it work
& $py @pyArgs gamelog_reader.py --once

# 5. Start with Windows, hidden
$pyw = & $py @pyArgs -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Game Log reader.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $pyw
$s.Arguments = '"' + (Join-Path $here 'gamelog_reader.py') + '"'
$s.WorkingDirectory = $here
$s.Save()
Start-Process $pyw -ArgumentList ('"' + (Join-Path $here 'gamelog_reader.py') + '"') -WorkingDirectory $here
Write-Host ""
Write-Host "Running now, and it starts with Windows. Log: $here\gamelog-reader.log"
Read-Host 'Press Enter to close'
