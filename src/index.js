// src/index.js
// ADAPTADOR Baileys (WhatsApp NAO oficial). Apenas:
//  - conecta no WhatsApp
//  - traduz o jid em um contactId estavel
//  - entrega a mensagem ao NUCLEO (core.js) e devolve a resposta
//  - envia o resumo ao dono quando o nucleo notifica
// Toda a logica de verdade esta no core.js. Para a API oficial (marco 4),
// basta criar outro adaptador que chame o MESMO core.js.
import 'dotenv/config';

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { processarMensagem, manutencaoInicial, ehDono } from './core.js';
import { CLIENTE } from './config-cliente.js';

if (process.env.MOCK !== 'true' && !process.env.ANTHROPIC_API_KEY) {
  console.error('\n[ERRO] ANTHROPIC_API_KEY nao encontrada. Rode "npm run check".\n');
  process.exit(1);
}

// Numero do dono: prioriza env DONO_WHATSAPP; se nao houver, usa o primeiro
// de CLIENTE.donosWhatsApp.
function numeroDono() {
  const bruto = process.env.DONO_WHATSAPP || (CLIENTE.donosWhatsApp || [])[0] || '';
  return String(bruto).replace(/\D/g, '');
}

const DONO_NUM = numeroDono();
const DONO_JID = DONO_NUM ? `${DONO_NUM}@s.whatsapp.net` : null;
if (!DONO_JID) {
  console.warn('[AVISO] Numero do dono nao configurado. Pedidos so no terminal.\n');
}

function extrairTexto(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || null;
}

function fmtBRL(v) {
  const n = Number(v || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarResumoPedido({ id, pedido, telefoneOrigem }) {
  const linhas = [
    `🍔 NOVO PEDIDO #${id}`,
    `Cliente: ${pedido.cliente_nome || '-'}`,
    `Tel: wa.me/${telefoneOrigem}`,
    '',
    'Itens:',
  ];
  for (const it of pedido.itens || []) {
    const obs = it.observacoes ? ` (${it.observacoes})` : '';
    linhas.push(`- ${it.quantidade}x ${it.nome}${obs} - ${fmtBRL(it.subtotal)}`);
  }
  linhas.push('');
  linhas.push(`Subtotal: ${fmtBRL(pedido.subtotal)}`);
  linhas.push(`Taxa entrega: ${fmtBRL(pedido.taxa_entrega)}`);
  linhas.push(`TOTAL: ${fmtBRL(pedido.total)}`);
  linhas.push('');
  linhas.push(`Endereco: ${pedido.endereco || '-'}${pedido.bairro ? ` - ${pedido.bairro}` : ''}`);
  if (pedido.referencia) linhas.push(`Referencia: ${pedido.referencia}`);
  linhas.push('');
  const troco = pedido.troco_para ? ` (troco pra ${fmtBRL(pedido.troco_para)})` : '';
  linhas.push(`Pagamento: ${pedido.forma_pagamento || '-'}${troco}`);
  if (pedido.observacoes) linhas.push(`Obs: ${pedido.observacoes}`);
  return linhas.join('\n');
}

function formatarResumoHandoff({ motivo, telefoneOrigem }) {
  return [
    '⚠️ ATENDIMENTO HUMANO',
    `Cliente pediu para falar com voce.`,
    `Contato: wa.me/${telefoneOrigem}`,
    `Motivo: ${motivo || '-'}`,
    '',
    `Bot pausado por algumas horas nesta conversa.`,
  ].join('\n');
}

async function iniciar() {
  manutencaoInicial();

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }) });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\nEscaneie o QR no WhatsApp > Aparelhos conectados:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('\nConectado! Mande mensagem de OUTRO numero para testar.');
      if (process.env.MOCK === 'true') console.log('(MODO MOCK: sem gastar API.)');
      if (DONO_JID) console.log(`Notificacoes de pedido vao para: ${DONO_NUM}`);
      console.log('');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = code !== DisconnectReason.loggedOut;
      console.log('Conexao fechada. Reconectar:', deveReconectar);
      if (deveReconectar) iniciar();
      else console.log('Sessao encerrada. Apague a pasta "auth" e rode de novo.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jidRaw = msg.key.remoteJid;
      if (msg.key.fromMe || !jidRaw) continue;
      if (jidRaw === 'status@broadcast' || jidRaw.endsWith('@g.us') || jidRaw.endsWith('@newsletter')) continue;

      const contactId = jidNormalizedUser(jidRaw);
      // Ignora mensagens que vem do proprio dono (evita loop e conversa acidental).
      if (ehDono(contactId)) continue;
      if (DONO_JID && contactId === jidNormalizedUser(DONO_JID)) continue;

      const texto = extrairTexto(msg);
      if (!texto) continue;

      const telefoneOrigem = contactId.split('@')[0];

      try {
        await sock.sendPresenceUpdate('composing', jidRaw);

        const { resposta, origem, ate } = await processarMensagem({
          contactId,
          texto,
          notificarDono: async (info) => {
            let mensagemDono;
            if (info.tipo === 'pedido') {
              mensagemDono = formatarResumoPedido({
                id: info.id,
                pedido: info.pedido,
                telefoneOrigem,
              });
            } else if (info.tipo === 'handoff') {
              mensagemDono = formatarResumoHandoff({
                motivo: info.motivo,
                telefoneOrigem,
              });
            } else {
              return;
            }

            if (DONO_JID) {
              await sock.sendMessage(DONO_JID, { text: mensagemDono });
              console.log(`[${info.tipo}] enviado ao dono.`);
            } else {
              console.log(`\n===== ${info.tipo.toUpperCase()} (dono nao configurado) =====`);
              console.log(mensagemDono);
              console.log('=====================================================\n');
            }
          },
        });

        console.log(`[ctx] ${contactId} -> ${origem}`);

        if (origem === 'pausado') {
          console.log(`[pausado] ${contactId} em handoff ate ${new Date(ate).toISOString()} - bot nao responde.`);
          continue;
        }

        await sock.sendMessage(jidRaw, { text: resposta });
        console.log(`[${contactId}] respondido.`);
      } catch (e) {
        console.error('Erro ao responder:', e?.message || e);
      }
    }
  });
}

iniciar();
