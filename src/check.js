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
  // Mostra so o comeco e o fim, nunca a chave inteira.
  const ini = k.slice(0, 7);
  const fim = k.slice(-4);
  console.log(`ANTHROPIC_API_KEY: encontrada ✅  (${ini}...${fim}, ${k.length} caracteres)`);
  if (!k.startsWith('sk-ant-')) {
    console.log('AVISO: a chave normalmente comeca com "sk-ant-". Confira se colou certo.');
  }
}
console.log('MOCK:', process.env.MOCK || '(nao definido = usa API real)');
console.log('---------------------------\n');
