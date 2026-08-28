#!/usr/bin/env bash
# start-bot.sh - conecta o WhatsApp (1a vez) e poe o bot pra rodar 24/7 com PM2.
set -e

if [ ! -f ".env" ]; then
  echo "ERRO: arquivo .env nao encontrado. Crie com:  nano .env"
  exit 1
fi

if [ ! -d "auth" ] || [ -z "$(ls -A auth 2>/dev/null)" ]; then
  echo "==> Primeira conexao: vou abrir o QR code."
  echo "    Escaneie com o WhatsApp do numero 2 (Aparelhos conectados)."
  echo "    Quando aparecer 'Conectado!', aperte Ctrl+C para continuar."
  echo ""
  sleep 2
  node src/index.js || true
fi

echo "==> Colocando o bot sob o PM2 (24/7)..."
pm2 delete corretor-ia >/dev/null 2>&1 || true
pm2 start src/index.js --name corretor-ia
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || pm2 startup || true
pm2 save

echo ""
echo "============================================================"
echo " Bot rodando 24/7! Pode fechar o terminal e desligar o PC."
echo "   pm2 status              -> ver se esta no ar"
echo "   pm2 logs corretor-ia    -> ver conversas/erros"
echo "   pm2 restart corretor-ia -> reiniciar (apos mudar config)"
echo "============================================================"