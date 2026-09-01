// src/test.js
// Chat no terminal usando o MESMO nucleo (core.js). Simula um contato fixo.
// Rodar: npm run chat   | Sair: "sair" ou Ctrl+C
import 'dotenv/config';
import readline from 'node:readline';
import { processarMensagem, manutencaoInicial } from './core.js';

if (process.env.MOCK !== 'true' && !process.env.ANTHROPIC_API_KEY) {
  console.error('\n[ERRO] ANTHROPIC_API_KEY nao encontrada no .env.\n');
  process.exit(1);
}

manutencaoInicial();

const CONTATO = 'teste@terminal';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n=== Chat de teste (digite "sair" para encerrar) ===');
if (process.env.MOCK === 'true') console.log('(MODO MOCK: sem gastar API)');

function perguntar() {
  rl.question('\nVoce: ', async (texto) => {
    if (texto.trim().toLowerCase() === 'sair') return rl.close();
    try {
      const { resposta, origem } = await processarMensagem({
        contactId: CONTATO,
        texto,
        notificarDono: async (info) => {
          if (info.tipo === 'pedido') {
            console.log(`\n>>> [PEDIDO #${info.id} -> DONO]:`);
            console.log(JSON.stringify(info.pedido, null, 2));
          } else if (info.tipo === 'handoff') {
            console.log(`\n>>> [HANDOFF HUMANO -> DONO] motivo: ${info.motivo}`);
          }
        },
      });
      console.log(`[ctx] ${origem}`);
      if (resposta === null) {
        console.log(`(bot em pausa - handoff humano; nao responde)`);
      } else {
        console.log(`\nAtendente: ${resposta}`);
      }
    } catch (e) {
      console.error('Erro:', e?.message || e);
    }
    perguntar();
  });
}
perguntar();
