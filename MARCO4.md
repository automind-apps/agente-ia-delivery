# Migracao para a WhatsApp Cloud API (oficial)

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
tarefa concreta de negocio. Nosso bot faz isso (receber pedido de delivery e
notificar o dono), entao esta alinhado. Mantenha o atendente focado nessa tarefa.

## Como fica o codigo (esqueleto - NAO rodar ainda)
Um servidor Express com dois endpoints de webhook, chamando o MESMO core.js:

```js
// server-oficial.js  (adaptador da API oficial - esqueleto)
import 'dotenv/config';
import express from 'express';
import { processarMensagem, manutencaoInicial, ehDono } from './core.js';
import { CLIENTE } from './config-cliente.js';

const app = express();
app.use(express.json());
manutencaoInicial();

const TOKEN_VERIFICACAO = process.env.WA_VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;             // token da Meta
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;   // id do numero na WABA
const DONO = (process.env.DONO_WHATSAPP || (CLIENTE.donosWhatsApp || [])[0] || '')
  .toString().replace(/\D/g, '');

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

function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarResumoPedido({ id, pedido, contactId }) {
  const linhas = [
    `NOVO PEDIDO #${id}`,
    `Cliente: ${pedido.cliente_nome || '-'}`,
    `Tel: wa.me/${contactId}`,
    '',
    'Itens:',
    ...(pedido.itens || []).map((it) => {
      const obs = it.observacoes ? ` (${it.observacoes})` : '';
      return `- ${it.quantidade}x ${it.nome}${obs} - ${fmtBRL(it.subtotal)}`;
    }),
    '',
    `Subtotal: ${fmtBRL(pedido.subtotal)}`,
    `Taxa: ${fmtBRL(pedido.taxa_entrega)}`,
    `TOTAL: ${fmtBRL(pedido.total)}`,
    '',
    `Endereco: ${pedido.endereco || '-'}${pedido.bairro ? ' - ' + pedido.bairro : ''}`,
    pedido.referencia ? `Ref: ${pedido.referencia}` : null,
    `Pagamento: ${pedido.forma_pagamento || '-'}${
      pedido.troco_para ? ' (troco pra ' + fmtBRL(pedido.troco_para) + ')' : ''
    }`,
  ].filter(Boolean);
  return linhas.join('\n');
}

// 2) Recebimento de mensagens (POST).
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rapido; processa depois
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const contactId = msg.from;      // numero do cliente = identidade ESTAVEL
    const texto = msg.text.body;

    // Ignora mensagens vindas do proprio dono (evita loop).
    if (ehDono(contactId)) return;

    const { resposta, origem, ate } = await processarMensagem({
      contactId,
      texto,
      notificarDono: async (info) => {
        if (!DONO) return;
        if (info.tipo === 'pedido') {
          await enviarTexto(DONO, formatarResumoPedido({
            id: info.id,
            pedido: info.pedido,
            contactId,
          }));
        } else if (info.tipo === 'handoff') {
          await enviarTexto(
            DONO,
            `ATENDIMENTO HUMANO\nCliente: wa.me/${contactId}\nMotivo: ${info.motivo || '-'}`
          );
        }
      },
    });

    // Handoff ativo: bot NAO responde (dono conversa manualmente).
    if (origem === 'pausado') {
      console.log(`[pausado] ${contactId} ate ${new Date(ate).toISOString()}`);
      return;
    }

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
6. Aprovar um ou dois templates (para reabrir conversa fora das 24h) - ex.:
   "seu pedido #{{1}} saiu para entrega" ou "temos uma promocao hoje".
