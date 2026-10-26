# Instalador do Agente Prumo (roda pelo instalar.bat)
$ErrorActionPreference = "Stop"
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "=== Agente Prumo - instalacao ===" -ForegroundColor Cyan

# 1) Python
$py = $null; $pyw = $null; $extra = ""; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) { $py = "py"; $extra = "-3"; $pyArgs = @("-3"); $pyw = (Get-Command pyw -ErrorAction SilentlyContinue).Source }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = "python"; $pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source }
if (-not $py) { Write-Host "Python nao encontrado. Instale em https://www.python.org (marque 'Add python.exe to PATH') e rode de novo." -ForegroundColor Red; exit 1 }
& $py @pyArgs --version

# 2) Bibliotecas (Selenium)
Write-Host "Instalando bibliotecas..."
& $py @pyArgs -m pip install --user --upgrade -r (Join-Path $pasta "requirements.txt")

# 3) Firefox
$ff = @("$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe") | Where-Object { Test-Path $_ }
if (-not $ff) { Write-Host "ATENCAO: Firefox nao encontrado. Instale o Firefox antes de usar o robo." -ForegroundColor Yellow }

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
