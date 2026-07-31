[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Npm {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  Write-Host ""
  Write-Host "==> $Description" -ForegroundColor Cyan
  & npm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description falhou com codigo $LASTEXITCODE."
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "Este script deve ser executado no Windows."
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $npmCommand) {
  throw "Node.js e npm nao foram encontrados. Instale o Node.js 22 LTS e abra um novo terminal."
}

Set-Location $PSScriptRoot

$nodeVersion = (& node.exe -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) {
  throw "Node.js $nodeVersion nao e suportado. Instale o Node.js 22 LTS."
}

Write-Host "Ponte ID - Gerador do instalador Windows" -ForegroundColor Green
Write-Host "Diretorio: $PSScriptRoot"
Write-Host "Node.js: v$nodeVersion"
Write-Host "npm: $(& npm.cmd --version)"

if (-not $SkipInstall) {
  Invoke-Npm -Arguments @("ci") -Description "Instalando dependencias exatas do package-lock.json"
}

if (-not $SkipTests) {
  Invoke-Npm -Arguments @("test") -Description "Executando testes automatizados"
}

Invoke-Npm -Arguments @("run", "clean") -Description "Removendo builds anteriores"
Invoke-Npm -Arguments @("run", "dist:win") -Description "Gerando instalador NSIS x64"

$releaseDirectory = Join-Path $PSScriptRoot "release"
$installers = @(Get-ChildItem -Path $releaseDirectory -Filter "*Setup*.exe" -File)
if ($installers.Count -eq 0) {
  throw "O electron-builder terminou sem gerar um instalador em $releaseDirectory."
}

Write-Host ""
Write-Host "Build concluida com sucesso." -ForegroundColor Green
foreach ($installer in $installers) {
  $sizeMb = [math]::Round($installer.Length / 1MB, 2)
  $hash = (Get-FileHash -Path $installer.FullName -Algorithm SHA256).Hash
  Write-Host "Instalador: $($installer.FullName)"
  Write-Host "Tamanho: $sizeMb MB"
  Write-Host "SHA-256: $hash"
}
