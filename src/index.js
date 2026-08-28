// src/index.js
// ADAPTADOR Baileys (WhatsApp NAO oficial). Apenas:
//  - conecta no WhatsApp
//  - traduz o jid em um contactId estavel
//  - entrega a mensagem ao NUCLEO (core.js) e devolve a resposta
//  - envia o resumo ao corretor quando o nucleo manda
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

if (process.env.MOCK !== 'true' && !process.env.ANTHROPIC_API_KEY) {
  console.error('\n[ERRO] ANTHROPIC_API_KEY nao encontrada. Rode "npm run check".\n');
  process.exit(1);
}

const CORRETOR = process.env.CORRETOR_WHATSAPP
  ? `${process.env.CORRETOR_WHATSAPP.replace(/\D/g, '')}@s.whatsapp.net`
  : null;
if (!CORRETOR) console.warn('[AVISO] CORRETOR_WHATSAPP nao definido. Leads so no terminal.\n');

function extrairTexto(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || null;
}

function formatarResumoLead(dados, telefoneOrigem) {
  const contato = dados.telefone_contato ? dados.telefone_contato : `wa.me/${telefoneOrigem}`;
  const linhas = [
    '*Novo lead qualificado* 🏠',
    `Nome: ${dados.nome || '-'}`,
    `Quer: ${dados.intencao || '-'}`,
    dados.tipo_imovel ? `Imovel: ${dados.tipo_imovel}` : null,
    dados.quartos ? `Quartos: ${dados.quartos}` : null,
    dados.bairro ? `Bairro: ${dados.bairro}` : null,
    dados.faixa_valor ? `Valor: ${dados.faixa_valor}` : null,
    dados.forma_pagamento ? `Pagamento: ${dados.forma_pagamento}` : null,
    dados.urgencia ? `Urgencia: ${dados.urgencia}` : null,
    '',
    `Resumo: ${dados.resumo || '-'}`,
    '',
    `Contato: ${contato}`,
    `(WhatsApp de origem: wa.me/${telefoneOrigem})`,
  ];
  return linhas.filter((l) => l !== null).join('\n');
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
      if (CORRETOR) console.log(`Leads vao para: ${process.env.CORRETOR_WHATSAPP}`);
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

      const contactId = jidNormalizedUser(jidRaw); // chave estavel
      // Ignora o proprio corretor (ele recebe os resumos), EXCETO se esse numero
      // tambem for um dono cadastrado - nesse caso a mensagem entra em "modo dono".
      if (CORRETOR && contactId === jidNormalizedUser(CORRETOR) && !ehDono(contactId)) continue;

      const texto = extrairTexto(msg);
      if (!texto) continue;

      const telefoneOrigem = contactId.split('@')[0];

      try {
        await sock.sendPresenceUpdate('composing', jidRaw);

        const { resposta, origem } = await processarMensagem({
          contactId,
          texto,
          notificarCorretor: async ({ dados }) => {
            const resumo = formatarResumoLead(dados, telefoneOrigem);
            if (CORRETOR) {
              await sock.sendMessage(CORRETOR, { text: resumo });
              console.log('[LEAD] resumo enviado ao corretor.');
            } else {
              console.log('\n===== RESUMO DO LEAD (corretor nao configurado) =====');
              console.log(resumo);
              console.log('=====================================================\n');
            }
          },
        });

        console.log(`[ctx] ${contactId} -> ${origem}`);
        await sock.sendMessage(jidRaw, { text: resposta });
        console.log(`[${contactId}] respondido.`);
      } catch (e) {
        console.error('Erro ao responder:', e?.message || e);
      }
    }
  });
}

iniciar();
