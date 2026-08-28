#!/usr/bin/env bash
# setup-vps.sh - prepara o servidor e o projeto de uma vez so.
set -e

echo "==> Atualizando o sistema..."
apt update && apt upgrade -y

echo "==> Instalando Node.js 20..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "==> Instalando git e PM2..."
apt install -y git
npm install -g pm2

echo "==> Instalando dependencias do projeto..."
npm install

echo ""
echo "============================================================"
echo " Tudo instalado!"
node -v; npm -v; pm2 -v
echo ""
echo " PROXIMOS PASSOS (so 2):"
echo " 1) nano .env   (cole as variaveis, Ctrl+O Enter, Ctrl+X)"
echo " 2) bash start-bot.sh"
echo "============================================================"