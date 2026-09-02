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
import { formatarDataBR } from './agent.js';
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
} else if (DONO_NUM.length < 12 || DONO_NUM.length > 13) {
  // Brasil: fixo = 12 digitos (55+DDD+8), celular = 13 (55+DDD+9). Qualquer coisa
  // fora desse intervalo e quase certeza de erro de digitacao - avisa cedo.
  console.warn(
    `[AVISO] DONO_WHATSAPP="${DONO_NUM}" tem ${DONO_NUM.length} digitos. ` +
    `Numero brasileiro tem 12 (fixo) ou 13 (celular). Ex.: 5519999998888. ` +
    `Pedidos NAO serao entregues se o numero for invalido.\n`
  );
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

function formatarResumoPedido({ id, pedido, criado_em, telefoneOrigem }) {
  const tel = pedido.cliente_telefone || telefoneOrigem;
  const endereco = pedido.endereco
    ? `${pedido.endereco}${pedido.bairro ? ` - ${pedido.bairro}` : ''}`
    : (pedido.bairro || '-');
  const troco = pedido.troco_para ? ` (troco pra ${fmtBRL(pedido.troco_para)})` : '';

  const linhas = [
    `🍔 NOVO PEDIDO #${id}`,
    '',
    `Cliente: ${pedido.cliente_nome || '-'}`,
    `Telefone: ${tel}`,
    `Endereco: ${endereco}`,
    '',
    'Pedido:',
  ];
  for (const it of pedido.itens || []) {
    const obs = it.observacoes ? ` (${it.observacoes})` : '';
    linhas.push(`- ${it.quantidade}x ${it.nome}${obs} - ${fmtBRL(it.subtotal)}`);
  }
  linhas.push('');
  linhas.push(`Subtotal: ${fmtBRL(pedido.subtotal)}`);
  linhas.push(`Taxa de entrega: ${fmtBRL(pedido.taxa_entrega)}`);
  linhas.push(`TOTAL (com entrega): ${fmtBRL(pedido.total)}`);
  linhas.push('');
  linhas.push(`Pagamento: ${pedido.forma_pagamento || '-'}${troco}`);
  if (pedido.observacoes) linhas.push(`Observacao: ${pedido.observacoes}`);
  linhas.push('');
  linhas.push(`Feito em: ${formatarDataBR(criado_em)}`);
  linhas.push(`Previsao de entrega: ${formatarDataBR(pedido.previsao_entrega)}`);
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
      if (DONO_JID) {
        console.log(`Notificacoes de pedido vao para: ${DONO_NUM}`);
        // Verifica se o numero do dono esta realmente registrado no WhatsApp.
        // Se nao estiver, o sendMessage vai falhar silencioso mais tarde - avisamos AGORA.
        (async () => {
          try {
            const [info] = await sock.onWhatsApp(DONO_NUM);
            if (!info?.exists) {
              console.warn(
                `\n[AVISO CRITICO] O numero DONO_WHATSAPP=${DONO_NUM} NAO esta registrado no WhatsApp.\n` +
                `Os resumos de pedido NAO serao entregues. Verifique se digitou o numero certo,\n` +
                `se ele tem WhatsApp ativo, e reinicie o bot depois de corrigir o .env.\n`
              );
            } else {
              console.log(`[dono] numero verificado no WhatsApp: OK (jid=${info.jid})`);
            }
          } catch (e) {
            console.warn(`[dono] nao consegui verificar registro do numero: ${e?.message || e}`);
          }
        })();
      }
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
                criado_em: info.criado_em,
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

            // SEMPRE imprime no terminal - garantia de que o dono ve o pedido
            // (mesmo que o envio no WhatsApp falhe por qualquer motivo).
            console.log(`\n===== ${info.tipo.toUpperCase()} =====`);
            console.log(mensagemDono);
            console.log('=====================================================\n');

            if (!DONO_JID) {
              console.log('[dono] nao configurado - resumo apenas no terminal.');
              return;
            }

            // Tenta enviar pro WhatsApp do dono. Se o Baileys der erro (numero
            // sem WA ativo, sessao caida, etc), o resumo AINDA foi impresso acima.
            try {
              console.log(`[dono] enviando ${info.tipo} para ${DONO_JID}...`);
              const r = await sock.sendMessage(DONO_JID, { text: mensagemDono });
              console.log(`[dono] ${info.tipo} enviado. messageId=${r?.key?.id || '?'}`);
            } catch (e) {
              console.error(
                `[dono] FALHA ao enviar ${info.tipo} para ${DONO_JID}: ${e?.message || e}\n` +
                `       Confirme se o numero tem WhatsApp ativo. Resumo salvo acima no terminal.`
              );
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
