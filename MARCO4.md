# Marco 4 - Migrar para a WhatsApp Cloud API (oficial)

O objetivo: trocar o Baileys (nao oficial, com risco de ban e identidade instavel)
pela API oficial da Meta. **O nucleo (core.js, agent.js, db.js, config-cliente.js)
NAO muda.** So criamos um novo adaptador no lugar do index.js.

## O que a API oficial resolve
- Identidade ESTAVEL: cada contato e o numero de telefone (e o BSUID novo da Meta).
  Acaba a inconsistencia de retomar conversa.
- Sem risco de ban: e o caminho que a Meta autoriza.
- Profissional: nome verificado, selo, escala.

## O que ela exige (seja realista no prazo)
1. Conta no Meta Business Manager **verificada** (documento da empresa/CNPJ).
2. Uma WhatsApp Business Account (WABA) e um numero dedicado que **nao** esteja
   no app normal do WhatsApp e consiga receber SMS/voz para ativar.
3. Um endpoint HTTPS publico para o **webhook** (recebe as mensagens).
4. Templates de mensagem aprovados pela Meta (so para iniciar conversa fora da
   janela de 24h; resposta dentro de 24h da mensagem do cliente e livre).
5. App Review / Go-live.

Prazo realista: direto na Meta, alguns dias (verificacao + aprovacoes). Por um
BSP (Business Solution Provider), costuma sair em 24-48h, mas com custo/markup.

## Custo
- Usar a Cloud API em si e gratis; voce paga a Meta por mensagem/conversa.
- Respostas dentro da janela de 24h iniciada pelo cliente: **gratuitas**.
- Como nosso bot responde a quem mandou mensagem, a maior parte cai na janela
  gratuita. Mensagens proativas (templates) sao pagas, por pais/categoria.

## Importante (regra 2026)
A Meta nao aceita mais "chatbot aberto" generico: a IA precisa cumprir uma
tarefa concreta de negocio. Nosso bot faz isso (qualificar lead e encaminhar),
entao esta alinhado. Mantenha o atendente focado nessa tarefa.

## Como fica o codigo (esqueleto - NAO rodar ainda)
Um servidor Express com dois endpoints de webhook, chamando o MESMO core.js:

```js
// server-oficial.js  (adaptador da API oficial - esqueleto)
import 'dotenv/config';
import express from 'express';
import { processarMensagem, manutencaoInicial } from './core.js';

const app = express();
app.use(express.json());
manutencaoInicial();

const TOKEN_VERIFICACAO = process.env.WA_VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;             // token da Meta
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;   // id do numero na WABA
const CORRETOR = process.env.CORRETOR_WHATSAPP;    // numero do corretor

// 1) Verificacao do webhook (GET) - a Meta chama uma vez ao configurar.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === TOKEN_VERIFICACAO) return res.send(challenge);
  return res.sendStatus(403);
});

// Helper: enviar mensagem de texto pela API oficial.
async function enviarTexto(para, texto) {
  await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
  });
}

// 2) Recebimento de mensagens (POST).
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rapido; processa depois
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const contactId = msg.from;      // numero do cliente = identidade ESTAVEL
    const texto = msg.text.body;

    const { resposta } = await processarMensagem({
      contactId,
      texto,
      notificarCorretor: async ({ dados }) => {
        const resumo = `Novo lead: ${dados.nome || '-'} | ${dados.intencao} | ${dados.resumo}\nContato: ${dados.telefone_contato || contactId}`;
        if (CORRETOR) await enviarTexto(CORRETOR, resumo);
      },
    });

    await enviarTexto(contactId, resposta);
  } catch (e) {
    console.error('Erro no webhook:', e);
  }
});

app.listen(3000, () => console.log('Webhook oficial ouvindo na porta 3000'));
```

Repare: `processarMensagem` e identico ao que ja usamos. Muda so como a
mensagem chega (webhook) e como a resposta sai (fetch na Graph API).

## Passos praticos quando voce decidir ir
1. Criar/verificar o Business Manager na Meta.
2. Criar a WABA + numero dedicado.
3. Configurar o webhook (precisa de HTTPS publico; em dev da pra usar um tunel
   tipo ngrok/cloudflared apontando para a porta 3000).
4. Pegar WA_TOKEN e WA_PHONE_NUMBER_ID e por no .env.
5. Trocar `npm start` para rodar o server-oficial.js.
6. Aprovar um ou dois templates (para reabrir conversa fora das 24h).
