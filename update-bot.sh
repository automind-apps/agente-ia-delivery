#!/usr/bin/env bash
# update-bot.sh - atualiza o codigo (do GitHub) e reinicia o bot.
# 'set -e' aborta o script no primeiro comando que falhar - se npm test quebrar,
# o pm2 restart NAO roda e o bot em producao segue na versao anterior (segura).
set -e
git pull
npm install
npm test
pm2 restart corretor-ia
echo "==> Atualizado, testado e reiniciado."