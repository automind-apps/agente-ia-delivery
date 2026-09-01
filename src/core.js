// src/core.js
// ==========================================================================
// NUCLEO independente do transporte. NAO sabe se a mensagem veio do Baileys
// ou da API oficial do WhatsApp. Recebe um "contactId" estavel + o texto, e
// devolve a resposta (ou null se estiver em pausa por handoff humano).
//
// Migracao para a API oficial (marco 4) = trocar so o adaptador (index.js).
// ==========================================================================
import { gerarResposta } from './agent.js';
import { CLIENTE } from './config-cliente.js';
import {
  carregarHistorico,
  salvarMensagem,
  salvarPedido,
  ultimaMensagemMs,
  podarMensagensAntigas,
  limparContato,
  pausarAtendimento,
  estaEmPausa,
} from './db.js';

const RESUME_WINDOW_MS = (Number(process.env.RESUME_WINDOW_HOURS) || 168) * 60 * 60 * 1000;
const LIMPAR_HISTORICO_ANTIGO = process.env.LIMPAR_HISTORICO_ANTIGO === 'true';
const MAX_MENSAGENS = 20;
// Quantas horas o bot fica em silencio depois de "passar para humano".
const PAUSA_HANDOFF_HORAS = Number(process.env.PAUSA_HANDOFF_HORAS) || 4;

// Cache em memoria das conversas ATIVAS. Enquanto o contato esta aqui,
// nao lemos o banco. conv = { hist: [], ts: ms }
const memoria = new Map();

// So digitos do numero de um contactId (jid "5511...@s.whatsapp.net" -> "5511...").
function numeroDe(contactId) {
  return String(contactId || '').split('@')[0].replace(/\D/g, '');
}

// Mensagem veio do numero do proprio dono? (evita loop / conversa acidental).
// Decisao em CODIGO pelo numero - nunca por alguem dizer "sou o dono".
export function ehDono(contactId) {
  const num = numeroDe(contactId);
  if (!num) return false;
  return (CLIENTE.donosWhatsApp || []).some((d) => String(d).replace(/\D/g, '') === num);
}

// Obtem a conversa: do cache (sem tocar no banco) OU do banco (uma unica vez).
function obterConversa(contactId) {
  const emMemoria = memoria.get(contactId);
  if (emMemoria) return { conv: emMemoria, origem: 'memoria' };

  const doBanco = carregarHistorico(contactId);
  const ultima = ultimaMensagemMs(contactId);
  const recente = ultima && Date.now() - ultima <= RESUME_WINDOW_MS;

  let origem;
  let hist;
  if (doBanco.length && recente) {
    hist = doBanco;
    origem = `banco (retomando ${doBanco.length} msgs)`;
  } else {
    hist = [];
    if (doBanco.length) {
      origem = 'banco (gap longo: nova conversa)';
      if (LIMPAR_HISTORICO_ANTIGO) {
        const n = limparContato(contactId);
        if (n) console.log(`[ctx] historico antigo de ${contactId} removido (${n} msgs).`);
      }
    } else {
      origem = 'contato novo';
    }
  }

  const conv = { hist, ts: Date.now() };
  memoria.set(contactId, conv);
  return { conv, origem };
}

// processarMensagem: ponto unico de entrada para QUALQUER transporte.
//  - contactId: identificador estavel do contato
//  - texto: a mensagem recebida
//  - notificarDono({ tipo, pedido?, id?, motivo?, contactId }): notificacao ao dono
//     tipo = 'pedido' (novo pedido) ou 'handoff' (transferido para humano)
// Retorna { resposta, origem } OU { resposta: null, origem: 'pausado', ate }
// quando a conversa esta em handoff humano (transporte NAO deve responder).
export async function processarMensagem({ contactId, texto, notificarDono }) {
  // Handoff humano: se conversa esta pausada, NAO responde nada.
  const pausa = estaEmPausa(contactId);
  if (pausa) {
    salvarMensagem(contactId, 'user', texto); // ainda salva pro dono ver o historico
    return { resposta: null, origem: 'pausado', ate: pausa.ate };
  }

  const { conv, origem } = obterConversa(contactId);

  conv.hist.push({ role: 'user', content: texto });
  salvarMensagem(contactId, 'user', texto);

  const resposta = await gerarResposta(conv.hist, {
    onPedido: async ({ pedido }) => {
      const id = salvarPedido(contactId, pedido);
      if (typeof notificarDono === 'function') {
        await notificarDono({ tipo: 'pedido', pedido, id, contactId });
      }
      return id;
    },
    onPassarHumano: async ({ motivo }) => {
      const ate = pausarAtendimento(contactId, PAUSA_HANDOFF_HORAS, motivo);
      console.log(`[handoff] ${contactId} pausado ate ${new Date(ate).toISOString()} (motivo: ${motivo})`);
      if (typeof notificarDono === 'function') {
        await notificarDono({ tipo: 'handoff', motivo, contactId });
      }
    },
  });

  conv.hist.push({ role: 'assistant', content: resposta });
  while (conv.hist.length > MAX_MENSAGENS) conv.hist.shift();
  conv.ts = Date.now();
  salvarMensagem(contactId, 'assistant', resposta);

  return { resposta, origem };
}

// Manutencao ao iniciar (poda de mensagens antigas - privacidade/LGPD).
export function manutencaoInicial() {
  try {
    const n = podarMensagensAntigas(30);
    if (n) console.log(`[manutencao] ${n} mensagens com +30 dias removidas.`);
  } catch (e) {
    console.error('Erro na poda:', e?.message || e);
  }
}
