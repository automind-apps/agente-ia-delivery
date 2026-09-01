// src/check.js
// Diagnostico rapido: confere se o .env esta sendo lido.
// Rodar com:  npm run check   (ou: node src/check.js)
import 'dotenv/config';

const k = process.env.ANTHROPIC_API_KEY;
console.log('\n--- Diagnostico do .env ---');
if (!k) {
  console.log('ANTHROPIC_API_KEY: NAO ENCONTRADA ❌');
  console.log('Confira se o arquivo se chama exatamente ".env" e esta na raiz do projeto.');
} else {
  const ini = k.slice(0, 7);
  const fim = k.slice(-4);
  console.log(`ANTHROPIC_API_KEY: encontrada ✅  (${ini}...${fim}, ${k.length} caracteres)`);
  if (!k.startsWith('sk-ant-')) {
    console.log('AVISO: a chave normalmente comeca com "sk-ant-". Confira se colou certo.');
  }
}

const dono = process.env.DONO_WHATSAPP;
if (dono) {
  const so = String(dono).replace(/\D/g, '');
  console.log(`DONO_WHATSAPP: ${so} (recebe as notificacoes de pedido)`);
} else {
  console.log('DONO_WHATSAPP: (nao definido) - pedidos so no terminal. Use o config-cliente.js ou defina no .env.');
}

console.log('MOCK:', process.env.MOCK || '(nao definido = usa API real)');
console.log('PAUSA_HANDOFF_HORAS:', process.env.PAUSA_HANDOFF_HORAS || '(padrao: 4)');
console.log('---------------------------\n');
