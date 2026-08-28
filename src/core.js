// src/core.js
// ==========================================================================
// NUCLEO independente do transporte. NAO sabe se a mensagem veio do Baileys
// ou da API oficial do WhatsApp. Recebe um "contactId" estavel + o texto, e
// devolve a resposta. Isso e o que torna a migracao para a API oficial (marco 4)
// uma simples troca de adaptador, sem mexer aqui.
//
// Identidade: assumimos um contactId ESTAVEL por contato (na API oficial sera
// o numero de telefone / BSUID; com Baileys, o jid normalizado).
// ==========================================================================
import { gerarResposta } from './agent.js';
import { CLIENTE } from './config-cliente.js';
import {
  carregarHistorico,
  salvarMensagem,
  salvarLead,
  podeRegistrarLead,
  ultimaMensagemMs,
  podarMensagensAntigas,
  limparContato,
  seedImoveis,
  listarImoveis,
  consultarImovel,
  setDisponibilidade,
} from './db.js';

const RESUME_WINDOW_MS = (Number(process.env.RESUME_WINDOW_HOURS) || 168) * 60 * 60 * 1000;
const LIMPAR_HISTORICO_ANTIGO = process.env.LIMPAR_HISTORICO_ANTIGO === 'true';
const MAX_MENSAGENS = 20;

// Cache em memoria das conversas ATIVAS. Enquanto o contato esta aqui,
// nao lemos o banco. conv = { hist: [], ts: ms, notificado: bool }
const memoria = new Map();

const normalizarId = (s) => String(s || '').trim().toUpperCase();

// So digitos do numero de um contactId (jid "5511...@s.whatsapp.net" -> "5511...").
function numeroDe(contactId) {
  return String(contactId || '').split('@')[0].replace(/\D/g, '');
}

// "Modo dono": a mensagem veio de um numero cadastrado em CLIENTE.donosWhatsApp.
// Decisao EM CODIGO pelo numero - nunca por alguem dizer "sou o dono" na conversa.
export function ehDono(contactId) {
  const num = numeroDe(contactId);
  if (!num) return false;
  return (CLIENTE.donosWhatsApp || []).some((d) => String(d).replace(/\D/g, '') === num);
}

// Aceita boolean, string "true"/"false", numero 0/1, e sim/nao. Retorna null
// se nao conseguiu decidir - preferimos falhar aberto a gravar valor errado.
// Exportado para permitir testes deterministicos (ver src/nucleo.test.js).
export function normalizarBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'sim', 'yes', 'disponivel', 'disponível'].includes(s)) return true;
    if (['false', '0', 'nao', 'não', 'no', 'indisponivel', 'indisponível'].includes(s)) return false;
  }
  return null;
}

// Resolve o ID exato contra o BANCO (fonte da verdade agora) e escreve o disponivel.
// Devolve a string de confirmacao/erro que volta ao modelo como tool_result.
// Exportado para permitir testes deterministicos (ver src/nucleo.test.js).
export function atualizarDisponibilidade({ imovel_id, disponivel }) {
  // Log de diagnostico: mostra EXATAMENTE o que o modelo mandou, e com que tipo.
  console.log(
    `[estoque] chamada atualizar_disponibilidade: imovel_id=${JSON.stringify(imovel_id)} ` +
      `disponivel=${JSON.stringify(disponivel)} (typeof=${typeof disponivel})`
  );

  const alvo = normalizarId(imovel_id);
  const todos = listarImoveis();
  const encontrado = todos.find((r) => normalizarId(r.id) === alvo);
  if (!encontrado) {
    const lista = todos.length ? todos.map((r) => r.id).join(', ') : 'nenhum imovel cadastrado';
    return `Imovel "${imovel_id}" nao encontrado. IDs validos: ${lista}. Peca para o dono especificar.`;
  }

  const dispBool = normalizarBool(disponivel);
  if (dispBool === null) {
    return `Nao entendi o status "${disponivel}". Chame de novo com disponivel=true (liberado) ou disponivel=false (alugado).`;
  }

  const ok = setDisponibilidade(encontrado.id, dispBool);
  const status = dispBool ? 'DISPONIVEL' : 'INDISPONIVEL';
  console.log(`[estoque] ${encontrado.id} -> ${status} (UPDATE affected=${ok})`);
  if (!ok) {
    return `Falha ao gravar ${encontrado.id} no banco (nenhuma linha atualizada). Tente de novo.`;
  }
  return `Pronto: ${encontrado.id} marcado como ${status}.`;
}

// Consulta por ID/descricao vinda do modelo (case-insensitive). Retorna a
// linha crua do banco (ou null); o agent.js formata o texto que o modelo le.
function resolverConsultaImovel({ imovel_id }) {
  const alvo = normalizarId(imovel_id);
  const todos = listarImoveis();
  return todos.find((r) => normalizarId(r.id) === alvo) || null;
}

// Obtem a conversa: do cache (sem tocar no banco) OU do banco (uma unica vez).
function obterConversa(contactId) {
  const emMemoria = memoria.get(contactId);
  if (emMemoria) return { conv: emMemoria, origem: 'memoria' };

  // Cache miss: le o banco UMA vez.
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
      // Opcional: apagar o historico velho para nao acumular (sua sugestao).
      if (LIMPAR_HISTORICO_ANTIGO) {
        const n = limparContato(contactId);
        if (n) console.log(`[ctx] historico antigo de ${contactId} removido (${n} msgs).`);
      }
    } else {
      origem = 'contato novo';
    }
  }

  const conv = { hist, ts: Date.now(), notificado: false };
  memoria.set(contactId, conv);
  return { conv, origem };
}

// processarMensagem: ponto unico de entrada para QUALQUER transporte.
//  - contactId: identificador estavel do contato
//  - texto: a mensagem recebida
//  - notificarCorretor({ dados, contactId }): chamado NO MAXIMO 1x por conversa
// Retorna { resposta, origem }.
export async function processarMensagem({ contactId, texto, notificarCorretor }) {
  const { conv, origem } = obterConversa(contactId);

  conv.hist.push({ role: 'user', content: texto });
  salvarMensagem(contactId, 'user', texto);

  // Roteia ja na entrada: dono atualiza estoque; lead e atendido como cliente.
  const modo = ehDono(contactId) ? 'dono' : 'lead';

  const resposta = await gerarResposta(conv.hist, {
    modo,
    onLead: async (dados) => {
      // Trava em memoria: 1 notificacao por conversa, sem excecao.
      if (conv.notificado) return;
      conv.notificado = true;

      // Trava cross-restart: nao reavisar se ja houve lead recente deste contato.
      const ehNovo = podeRegistrarLead(contactId);
      salvarLead(contactId, dados);
      if (ehNovo && typeof notificarCorretor === 'function') {
        await notificarCorretor({ dados, contactId });
      } else if (!ehNovo) {
        console.log('[LEAD] duplicado recente; salvo, corretor nao reavisado.');
      }
    },
    // Consulta de imoveis (usada nos dois modos - retorna TODOS com status; quem
    // decide como apresentar e o prompt do modo). Ferramenta unica: fim do
    // viés do historico + arquitetura mais simples.
    onListarImoveis: () => listarImoveis(),
    onConsultarImovel: (entrada) => resolverConsultaImovel(entrada),

    // Escrita exclusiva do dono. Trava final: so passa o callback quando
    // modo === 'dono'. Se um dia o agent.js escapar a checagem, aqui nem existe
    // funcao para chamar (defesa em camadas).
    onAtualizarDisponibilidade:
      modo === 'dono' ? (entrada) => atualizarDisponibilidade(entrada) : undefined,
  });

  conv.hist.push({ role: 'assistant', content: resposta });
  while (conv.hist.length > MAX_MENSAGENS) conv.hist.shift();
  conv.ts = Date.now();
  salvarMensagem(contactId, 'assistant', resposta);

  return { resposta, origem: modo === 'dono' ? `${origem} [dono]` : origem };
}

// Manutencao ao iniciar (poda de mensagens antigas - privacidade/LGPD) +
// garante uma linha de disponibilidade (default DISPONIVEL) para cada imovel do config.
export function manutencaoInicial() {
  try {
    const n = podarMensagensAntigas(30);
    if (n) console.log(`[manutencao] ${n} mensagens com +30 dias removidas.`);
  } catch (e) {
    console.error('Erro na poda:', e?.message || e);
  }
  try {
    const semente = CLIENTE.imoveis || [];
    seedImoveis(semente);
    if (semente.length) console.log(`[estoque] ${semente.length} imovel(is) semeado(s) do config.`);
  } catch (e) {
    console.error('Erro ao preparar estoque:', e?.message || e);
  }
}
