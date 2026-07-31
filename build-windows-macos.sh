#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script deve ser executado no macOS." >&2
  exit 1
fi

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js e npm não encontrados. Instale o Node.js 22 LTS e tente novamente." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "Node.js 20 ou superior é necessário. Recomendado: Node.js 22 LTS." >&2
  exit 1
fi

if [[ "$(uname -m)" == "arm64" ]] && ! /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
  echo "Rosetta 2 não encontrado. Instalando o componente necessário para gerar o NSIS..."
  /usr/sbin/softwareupdate --install-rosetta --agree-to-license
fi

echo "Ponte ID - gerando instalador Windows x64 no macOS"
npm ci
npm test
npm run clean
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win

installer="$(find release -maxdepth 1 -type f -name '*Setup*.exe' -print -quit)"
if [[ -z "$installer" ]]; then
  echo "A compilação terminou sem produzir o instalador .exe esperado." >&2
  exit 1
fi

size="$(du -h "$installer" | awk '{print $1}')"
hash="$(shasum -a 256 "$installer" | awk '{print $1}')"

echo
echo "Instalador criado com sucesso:"
echo "  Arquivo: $installer"
echo "  Tamanho: $size"
echo "  SHA-256: $hash"
