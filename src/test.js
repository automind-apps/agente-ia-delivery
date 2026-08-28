// src/test.js
// Chat no terminal usando o MESMO nucleo (core.js). Simula um contato fixo.
// Rodar: npm run chat   | Sair: "sair" ou Ctrl+C
import 'dotenv/config';
import readline from 'node:readline';
import { processarMensagem, manutencaoInicial } from './core.js';
import { CLIENTE } from './config-cliente.js';

if (process.env.MOCK !== 'true' && !process.env.ANTHROPIC_API_KEY) {
  console.error('\n[ERRO] ANTHROPIC_API_KEY nao encontrada no .env.\n');
  process.exit(1);
}

manutencaoInicial();

// "npm run chat dono" simula uma mensagem vinda do numero do dono (modo dono),
// usando o primeiro numero de CLIENTE.donosWhatsApp para casar a deteccao por numero.
const MODO_DONO = process.argv.includes('dono');
const numeroDono = (CLIENTE.donosWhatsApp || [])[0];
const CONTATO = MODO_DONO
  ? `${String(numeroDono || '').replace(/\D/g, '')}@terminal`
  : 'teste@terminal';

if (MODO_DONO && !numeroDono) {
  console.error('\n[ERRO] modo dono pedido, mas CLIENTE.donosWhatsApp esta vazio em config-cliente.js.\n');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n=== Chat de teste (digite "sair" para encerrar) ===');
if (MODO_DONO) console.log('(MODO DONO: atualizar estoque)');
if (process.env.MOCK === 'true') console.log('(MODO MOCK: sem gastar API)');

function perguntar() {
  rl.question('\nVoce: ', async (texto) => {
    if (texto.trim().toLowerCase() === 'sair') return rl.close();
    try {
      const { resposta, origem } = await processarMensagem({
        contactId: CONTATO,
        texto,
        notificarCorretor: async ({ dados }) => {
          console.log('\n>>> [LEAD -> CORRETOR] (no WhatsApp iria para o corretor):');
          console.log(JSON.stringify(dados, null, 2));
        },
      });
      console.log(`[ctx] ${origem}`);
      console.log(`\nAtendente: ${resposta}`);
    } catch (e) {
      console.error('Erro:', e?.message || e);
    }
    perguntar();
  });
}
perguntar();
