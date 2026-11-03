# Instalador do Agente Prumo (roda pelo instalar.bat)
$ErrorActionPreference = "Stop"
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "=== Agente Prumo - instalacao ===" -ForegroundColor Cyan

function Achar-Python {
  $script:py = $null; $script:pyw = $null; $script:extra = ""; $script:pyArgs = @()
  if (Get-Command py -ErrorAction SilentlyContinue) { $script:py = "py"; $script:extra = "-3"; $script:pyArgs = @("-3"); $script:pyw = (Get-Command pyw -ErrorAction SilentlyContinue).Source }
  elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $src = (Get-Command python).Source
    if ($src -notlike "*WindowsApps*") { $script:py = "python"; $script:pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source }  # o "python" da Microsoft Store e so um atalho
  }
}

# 1) Python (se nao tiver, instala sozinho pelo winget do Windows)
Achar-Python
if (-not $py) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Python nao encontrado: instalando o Python 3.12 (pode levar alguns minutos)..." -ForegroundColor Yellow
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
    Achar-Python
  }
}
if (-not $py) { Write-Host "Nao consegui instalar o Python sozinho. Instale em https://www.python.org (marque 'Add python.exe to PATH') e rode este instalador de novo." -ForegroundColor Red; exit 1 }
& $py @pyArgs --version

# 2) Pecas do robo (todas as do requirements.txt; o proprio Agente tambem confere ao abrir)
Write-Host "Instalando as pecas do robo..."
& $py @pyArgs -m pip install --user --upgrade --disable-pip-version-check -r (Join-Path $pasta "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "ATENCAO: alguma peca nao instalou (confira a internet). O Agente tenta de novo sozinho quando abrir." -ForegroundColor Yellow }

# 3) Google Chrome (o robo da NFA-e usa o Chrome)
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ }
if (-not $chrome -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Host "Google Chrome nao encontrado: instalando..." -ForegroundColor Yellow
  winget install -e --id Google.Chrome --silent --accept-package-agreements --accept-source-agreements
}

# 3b) fecha o Agente antigo, se estiver aberto (o novo abre no fim)
Get-CimInstance Win32_Process -Filter "Name like 'python%.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*prumo_agente.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 4) Atalhos: iniciar com o Windows (minimizado) e na area de trabalho
if (-not $pyw) { $pyw = (Get-Command $py).Source }
$script = Join-Path $pasta "prumo_agente.py"
$wsh = New-Object -ComObject WScript.Shell
foreach ($alvo in @(@([Environment]::GetFolderPath("Startup"), "--minimizado"), @([Environment]::GetFolderPath("Desktop"), ""))) {
  $lnk = $wsh.CreateShortcut((Join-Path $alvo[0] "Agente Prumo.lnk"))
  $lnk.TargetPath = $pyw
  $lnk.Arguments = ("$extra `"$script`" " + $alvo[1]).Trim()
  $lnk.WorkingDirectory = $pasta
  $lnk.IconLocation = (Join-Path $pasta "icone.ico")
  $lnk.Save()
}
Write-Host "Atalhos criados (inicia junto com o Windows)." -ForegroundColor Green

# 5) Nao suspender (opcional, so com confirmacao)
$r = Read-Host "Impedir que este computador suspenda quando estiver na tomada? (S/N)"
if ($r -match "^[sS]") { powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; Write-Host "Ok: nao vai suspender na tomada." -ForegroundColor Green }

# 6) Abre o agente
Start-Process -FilePath $pyw -ArgumentList ("$extra `"$script`"").Trim() -WorkingDirectory $pasta
Write-Host "Pronto! Na janela do Agente Prumo, informe o endereco do Prumo e o codigo de vinculo." -ForegroundColor Green
