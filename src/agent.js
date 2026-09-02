// src/agent.js
// O "cerebro" do atendente de delivery:
//  - conhecimento do estabelecimento (config-cliente.js)
//  - tool use: o modelo consulta cardapio, valida area/horario, e finaliza
//    o pedido chamando "registrar_pedido" (o CODIGO calcula preco/subtotal/total).
//  - GARANTIA dos campos minimos do pedido: eles sao OBRIGATORIOS no schema
//    da ferramenta, entao o modelo nao consegue registrar sem coletar cada um.
import Anthropic from '@anthropic-ai/sdk';
import { CLIENTE } from './config-cliente.js';

const MOCK = process.env.MOCK === 'true';
const MODEL = 'claude-haiku-4-5-20251001';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ---------- Utilitarios exportados (usados no core.js) ----------

// Normaliza texto para comparacao: minusculo, sem acento, trim.
export function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

// Casa um item por nome (case/acento-insensitive). Retorna { nome, descricao,
// preco, categoria, disponivel } ou null.
export function acharItemCardapio(nome) {
  const alvo = normalizarTexto(nome);
  if (!alvo) return null;
  for (const cat of CLIENTE.cardapio || []) {
    for (const it of cat.itens || []) {
      if (normalizarTexto(it.nome) === alvo) {
        return { ...it, categoria: cat.categoria };
      }
    }
  }
  return null;
}

// Formata BRL simples (R$ 12,00).
export function formatarBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Parseia CLIENTE.tempoMedioEntrega (string livre tipo "40-60 minutos", "1 hora",
// "45 min") e retorna o MAIOR valor em minutos. Usar o max e mais seguro para
// gerenciar expectativa - se cliente reclama, o dono nao esta em atraso ainda.
// Retorna 60 se nao conseguir parsear (fallback conservador).
export function tempoMedioEntregaMax(str = CLIENTE.tempoMedioEntrega) {
  const s = String(str || '').toLowerCase();
  const numeros = (s.match(/\d+/g) || []).map(Number);
  if (numeros.length === 0) return 60;
  const max = Math.max(...numeros);
  // Se a string menciona "hora" (mas nao "meia hora"), o numero e em horas.
  if (/\bhora/.test(s) && !/meia\s+hora/.test(s)) return max * 60;
  return max;
}

// Fuso horario fixo do negocio: America/Sao_Paulo (Brasil).
// Usar Intl.DateTimeFormat com timeZone explicito e o unico jeito de garantir
// que a hora exibida esta correta INDEPENDENTE de onde o servidor esta rodando
// (Windows local, VPS na Europa, cloud nos EUA - todos vao mostrar hora BR).
// Se um dia expandir para outros paises, este e o unico ponto a parametrizar
// (mover para o config-cliente.js com fusoHorario por estabelecimento).
const TZ_NEGOCIO = 'America/Sao_Paulo';

const _fmtHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ_NEGOCIO,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const _fmtData = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ_NEGOCIO,
  day: '2-digit',
  month: '2-digit',
});

// Formata timestamp ms como "HH:MM DD/MM" sempre no fuso America/Sao_Paulo.
export function formatarDataBR(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  return `${_fmtHora.format(d)} ${_fmtData.format(d)}`;
}

// Hora "agora" em Sao_Paulo como { hora, minuto, dia, mes } (numeros).
// Uso: passar para o system prompt para o modelo saber a hora local BRASILEIRA
// mesmo que o servidor esteja em UTC.
export function agoraEmSaoPaulo() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_NEGOCIO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = (t) => Number(partes.find((p) => p.type === t)?.value);
  return { ano: g('year'), mes: g('month'), dia: g('day'), hora: g('hour'), minuto: g('minute') };
}

// Bairro esta na lista de bairros atendidos? (case/acento-insensitive)
export function bairroAtendido(bairro) {
  const alvo = normalizarTexto(bairro);
  if (!alvo) return false;
  return (CLIENTE.bairrosAtendidos || []).some((b) => normalizarTexto(b) === alvo);
}

// ---------- Horario de funcionamento ----------
const DIAS_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

function paraMinutos(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Retorna { aberto: bool, proximoHorario: string|null, hoje: string }.
// "proximoHorario" so aparece quando fechado (frase para o modelo mostrar).
// Sempre calcula com fuso America/Sao_Paulo, ignora TZ do servidor.
// Se `now` for passado (usado em teste), respeita como se ja fosse hora BR
// (o teste controla a data absoluta que quer verificar).
export function statusHorario(now) {
  const cfg = CLIENTE.horarioFuncionamento || {};

  let diaIdx, minutosAgora;
  if (now) {
    // caminho de teste: usa a data como se fosse hora BR (mesmo comportamento antigo)
    diaIdx = now.getDay();
    minutosAgora = now.getHours() * 60 + now.getMinutes();
  } else {
    // producao: hora BR real, independente de onde o servidor esta.
    // Precisa do dia da semana em BR - Intl nao devolve, entao construimos.
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ_NEGOCIO,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const wk = partes.find((p) => p.type === 'weekday')?.value; // Sun, Mon, ...
    const idxByAbbr = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    diaIdx = idxByAbbr[wk] ?? 0;
    const hh = Number(partes.find((p) => p.type === 'hour')?.value || 0);
    const mi = Number(partes.find((p) => p.type === 'minute')?.value || 0);
    minutosAgora = hh * 60 + mi;
  }

  const dia = DIAS_SEMANA[diaIdx];

  const hoje = cfg[dia];
  if (hoje && !hoje.fechado) {
    const abre = paraMinutos(hoje.abre);
    const fecha = paraMinutos(hoje.fecha);
    if (abre != null && fecha != null) {
      // fecha <= abre = vira o dia (ex.: 18:00 -> 00:00 vira 18:00 -> 24:00)
      const fechaAjustado = fecha <= abre ? fecha + 24 * 60 : fecha;
      if (minutosAgora >= abre && minutosAgora < fechaAjustado) {
        return { aberto: true, proximoHorario: null, hoje: dia };
      }
      // fechado agora mas ainda vai abrir HOJE
      if (minutosAgora < abre) {
        return { aberto: false, proximoHorario: `hoje as ${hoje.abre}`, hoje: dia };
      }
    }
  }

  // procura o proximo dia que abre (ate 7 dias a frente)
  for (let i = 1; i <= 7; i++) {
    const idx = (diaIdx + i) % 7;
    const nome = DIAS_SEMANA[idx];
    const info = cfg[nome];
    if (info && !info.fechado && info.abre) {
      const quando = i === 1 ? 'amanha' : nome;
      return { aberto: false, proximoHorario: `${quando} as ${info.abre}`, hoje: dia };
    }
  }
  return { aberto: false, proximoHorario: null, hoje: dia };
}

// ---------- Formatadores de tool_result (o modelo le e parafraseia) ----------
function formatarCardapio(categoriaFiltro) {
  const cardapio = CLIENTE.cardapio || [];
  const cats = categoriaFiltro
    ? cardapio.filter((c) => normalizarTexto(c.categoria) === normalizarTexto(categoriaFiltro))
    : cardapio;
  if (!cats.length) {
    return categoriaFiltro
      ? `Categoria "${categoriaFiltro}" nao encontrada. Categorias disponiveis: ${cardapio
          .map((c) => c.categoria)
          .join(', ')}.`
      : 'Cardapio vazio.';
  }
  // O modelo apresenta ao cliente EXATAMENTE nesse formato (nome + ingredientes
  // do config, sem resumir). Se a categoria tem itens ESGOTADOS, o modelo apenas
  // os omite ou marca como indisponivel.
  const linhas = ['CARDAPIO (envie ao cliente exatamente neste formato, sem resumir os ingredientes):'];
  for (const cat of cats) {
    linhas.push(`\n*${cat.categoria}*`);
    for (const it of cat.itens || []) {
      const disp = it.disponivel === false ? ' [ESGOTADO]' : '';
      const desc = it.descricao ? `\n  ${it.descricao}` : '';
      linhas.push(`• ${it.nome} - ${formatarBRL(it.preco)}${disp}${desc}`);
    }
  }
  return linhas.join('\n');
}

function formatarStatusHorario() {
  const s = statusHorario();
  if (s.aberto) return 'ABERTO agora.';
  if (s.proximoHorario) return `FECHADO agora. Proximo horario: ${s.proximoHorario}.`;
  return 'FECHADO agora.';
}

// ---------- System prompt ----------
function horarioFuncionamentoFormatado() {
  const cfg = CLIENTE.horarioFuncionamento || {};
  return DIAS_SEMANA.map((d) => {
    const info = cfg[d];
    if (!info || info.fechado) return `${d}: fechado`;
    return `${d}: ${info.abre} as ${info.fecha}`;
  }).join('; ');
}

function montarSystemPrompt() {
  const observacoes = (CLIENTE.observacoesEspeciais || []).map((o) => `- ${o}`).join('\n');
  const pagamentos = (CLIENTE.formasPagamento || []).join(', ');

  // Hora atual do BRASIL (fuso fixo), nao do servidor. Isso impede o modelo de
  // dizer "boa noite" as 10h da manha porque o servidor esta em UTC.
  const a = agoraEmSaoPaulo();
  const horaAgora = `${String(a.hora).padStart(2, '0')}:${String(a.minuto).padStart(2, '0')}`;
  const dataAgora = `${String(a.dia).padStart(2, '0')}/${String(a.mes).padStart(2, '0')}/${a.ano}`;
  // Previsao se o pedido for fechado AGORA. O modelo copia isso pro resumo -
  // nao precisa fazer conta de minutos.
  const previsaoMs = Date.now() + tempoMedioEntregaMax() * 60 * 1000;
  const previsaoStr = formatarDataBR(previsaoMs);

  return `
Voce e o atendente virtual da ${CLIENTE.nomeEstabelecimento}, uma ${CLIENTE.tipoEstabelecimento} em ${CLIENTE.cidade}${CLIENTE.bairro ? ` (${CLIENTE.bairro})` : ''}. Atende no WhatsApp, 24 horas por dia.

HORARIO ATUAL (Brasil): ${horaAgora} de ${dataAgora}. Use esta hora para decidir "bom dia" / "boa tarde" / "boa noite" e para raciocinar sobre atraso e previsao. NUNCA chute a hora - use esta.
PREVISAO ATUAL (se o pedido for fechado agora): ${previsaoStr}. Use este valor no campo "Previsao de entrega" do resumo de confirmacao - nao invente hora, nao some minutos de cabeca.

SEU OBJETIVO: ajudar o cliente a fazer o pedido de forma RAPIDA, natural e sem atrito. Cliente com fome nao quer conversa longa.

REGRAS DE COMPORTAMENTO:
1. Fale como atendente amigavel brasileiro, informal mas educado. NUNCA use menus numerados forcados ("Digite 1 para..."). Deixe o cliente se expressar livremente.
2. Mensagens CURTAS estilo WhatsApp: 1 a 3 frases. Sem markdown. Emojis leves ok (nao exagere).
3. Se cliente perguntar cardapio, CHAME "consultar_cardapio" e envie ao cliente EXATAMENTE o texto que a ferramenta retornou (nome do item, ingredientes e preco). NAO resuma ingredientes, NAO reformule descricao, NAO omita ingrediente. Se o cliente pedir uma categoria especifica ("so as bebidas"), filtre pela categoria mas mantenha os itens no formato original.
4. Se cliente perguntar horario / "estao abertos?", CHAME "verificar_horario_funcionamento".
5. Se cliente pedir para falar com humano OU o pedido virar complexo (evento, encomenda grande, duvida detalhada sobre alergia/ingrediente), CHAME "passar_para_humano" e ai PARE - nao continue coletando pedido.
6. Se cliente perguntar sobre pedido ja feito ("cade meu pedido?", "esta atrasado?", "que horas chega?", "quanto tempo ainda?"), CHAME "consultar_meu_pedido" - a ferramenta devolve numero, hora do pedido, previsao de entrega e se estourou o prazo. NUNCA chute o tempo de cabeca. Se a previsao ja estourou, pece desculpas ao cliente e ofereca passar pra humano.

FLUXO DO PEDIDO (natural, uma coisa por vez, nao pareca formulario):
  a) ITENS que o cliente quer. Se ele mencionar observacao ("sem cebola",
     "ponto da carne"), anote no item. Se nao mencionar, NAO insista item por item.
  b) OBSERVACAO GERAL DO PEDIDO: assim que o cliente terminar de escolher os
     itens (antes de partir para nome/telefone), pergunte UMA vez se ele quer
     deixar alguma observacao (ex.: "sem cebola em nenhum, entregar sem tocar
     a campainha, casa amarela"). Se ele ja falou observacoes durante a escolha
     dos itens, essa pergunta ainda vale para uma OBS GERAL do pedido inteiro.
     Se ele disser que nao quer, tudo bem, siga.
  c) NOME do cliente.
  d) TELEFONE para contato do entregador (as vezes o WhatsApp esta em outro
     numero; confirmar direto e mais seguro).
  e) ENDERECO: apenas rua, numero, complemento (se houver) e bairro. NAO peca
     ponto de referencia.
  f) FORMA DE PAGAMENTO (${pagamentos}).
  g) Se pagar em dinheiro: TROCO PRA QUANTO.

O cliente pode adicionar/alterar observacao a QUALQUER momento da conversa,
inclusive na confirmacao final - se ele fizer isso, atualize e siga.

RESUMO DE CONFIRMACAO (obrigatorio antes de "registrar_pedido"):
Envie UMA UNICA mensagem ao cliente com este formato EXATO (mesmo layout que o
dono vai receber depois - as duas partes veem a mesma coisa):

  Confirma o pedido?

  Cliente: <nome>
  Telefone: <telefone>
  Endereco: <rua, numero, complemento se houver> - <bairro>

  Pedido:
  - <qtd>x <item> (<observacao se houver>) - R$ <preco do item x qtd>
  - ...

  Subtotal: R$ <soma dos itens>
  Taxa de entrega: R$ <taxa>
  TOTAL (com entrega): R$ <subtotal + taxa>

  Pagamento: <forma> (troco pra R$ <valor> - so se dinheiro com troco)
  Observacao: <obs geral se houver, senao omite a linha inteira>

  Feito em: <use exatamente o HORARIO ATUAL informado no topo deste prompt>
  Previsao de entrega: <use exatamente PREVISAO ATUAL informada no topo>

Depois pergunte "esta tudo certo pra fechar?".

===============================================================
!!! REGRA CRITICA E OBRIGATORIA !!!
Quando o cliente confirmar (disser "confirma", "pode ser", "isso mesmo", "ok",
"sim", "beleza", "fechado", "pode fechar", ou QUALQUER concordancia), sua
PROXIMA ACAO TEM que ser CHAMAR A FERRAMENTA "registrar_pedido". Isso NAO E
OPCIONAL.

- NUNCA responda em texto "pedido confirmado" / "pedido registrado" / "pronto,
  pedido feito" SEM antes ter chamado a ferramenta. Se voce nao chamou a
  ferramenta, o pedido NAO EXISTE no sistema, o dono NAO recebeu, e voce estara
  mentindo pro cliente.
- So DEPOIS que a ferramenta retornar sucesso, voce responde ao cliente com o
  NUMERO do pedido e a HORA prevista de entrega (informada no retorno da
  ferramenta).
- Se o cliente pedir alteracao apos ver o resumo, ajuste, mostre o resumo de
  novo, e espere nova confirmacao antes de chamar a ferramenta.
===============================================================

REGRAS DURAS (voce NAO PODE):
- Inventar item, preco, tempo de entrega ou taxa. Se nao esta no cardapio (resultado da ferramenta), diga que nao tem e sugira algo parecido.
- CALCULAR o total de cabeca. O CODIGO calcula quando voce chama "registrar_pedido" - voce so passa os itens com nome e quantidade. Mas voce PODE dizer o subtotal e total ao cliente na hora de confirmar (usando os precos que ja viu no cardapio); se estiver em duvida, chame "consultar_cardapio" de novo.
- Aceitar pedido abaixo do valor minimo (${formatarBRL(CLIENTE.valorMinimoPedido)}). Se for menor, informe e sugira adicionar item para atingir.
- Prometer coisa fora da politica (desconto especial, item nao listado, alteracao de receita).

REGRAS DE HORARIO:
- Se cliente escrever fora do horario de funcionamento, informe educadamente que estao fechados e diga o proximo horario (verificar com a ferramenta). MAS AINDA colete o pedido se ele quiser - o dono processa quando abrir. Deixe claro que "vai entrar quando abrir".

REGRAS DE PAGAMENTO:
- Formas aceitas: ${pagamentos}.
- Chave PIX: SO informar quando o cliente escolher PIX. Chave: ${CLIENTE.chavePix || '(nao configurada)'}.
- Se cliente escolher dinheiro, PERGUNTAR troco pra quanto. Se disser "sem troco" ou "valor exato", registrar sem troco.

REGRAS DE ENTREGA:
- Taxa padrao: ${formatarBRL(CLIENTE.taxaEntregaPadrao)} (adicionada ao total).
- Tempo medio: ${CLIENTE.tempoMedioEntrega}.
- Valor minimo do pedido: ${formatarBRL(CLIENTE.valorMinimoPedido)}.

OBSERVACOES DO ESTABELECIMENTO:
${observacoes || '(sem observacoes especiais)'}

HORARIO DE FUNCIONAMENTO:
${horarioFuncionamentoFormatado()}

TOM:
- Amigavel, brasileiro, natural. Nao muito formal, nao muito informal.
- Rapido e objetivo. Uma pergunta por vez.
- Acompanhe o tom do cliente (se ele for informal, seja informal).
`;
}

// ---------- Ferramentas ----------
const TOOL_CONSULTAR_CARDAPIO = {
  name: 'consultar_cardapio',
  description:
    'Retorna o cardapio (todos os itens com preco). Use SEMPRE que o cliente ' +
    'pedir para ver o cardapio, perguntar o que tem, ou pedir sugestao. Pode ' +
    'filtrar por categoria (ex.: "Hamburgueres", "Bebidas") passando o parametro ' +
    'categoria; sem parametro retorna o cardapio inteiro. Itens marcados ' +
    '[ESGOTADO] nao devem ser oferecidos.',
  input_schema: {
    type: 'object',
    properties: {
      categoria: {
        type: 'string',
        description: 'Opcional. Nome da categoria (ex.: "Hamburgueres").',
      },
    },
    required: [],
  },
};

const TOOL_VERIFICAR_HORARIO = {
  name: 'verificar_horario_funcionamento',
  description:
    'Verifica se o estabelecimento esta aberto AGORA. Se fechado, retorna o ' +
    'proximo horario de abertura. Use quando o cliente perguntar "estao abertos?", ' +
    '"que horas abre?", ou quando ele estiver iniciando um pedido fora do horario obvio.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const TOOL_CONSULTAR_MEU_PEDIDO = {
  name: 'consultar_meu_pedido',
  description:
    'Consulta o ULTIMO pedido registrado deste cliente. Use quando o cliente ' +
    'perguntar "cade meu pedido?", "quanto tempo ainda?", "o pedido ta atrasado?", ' +
    '"que horas vai chegar?", ou algo similar. Retorna numero do pedido, hora em ' +
    'que foi feito, previsao de entrega e status. Se nao houver pedido para este ' +
    'contato, retorna aviso.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const TOOL_PASSAR_PARA_HUMANO = {
  name: 'passar_para_humano',
  description:
    'Transfere a conversa para atendimento humano. Use quando o cliente pedir ' +
    'explicitamente ("quero falar com uma pessoa", "chamar humano") OU quando o ' +
    'pedido for complexo (evento, encomenda grande, duvida detalhada sobre ' +
    'ingrediente/alergia). Depois de chamar, o bot ficara silencioso naquela ' +
    'conversa por algumas horas para o dono responder.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        description: 'Motivo curto (1 frase) para o dono entender por que passou.',
      },
    },
    required: ['motivo'],
  },
};

const TOOL_REGISTRAR_PEDIDO = {
  name: 'registrar_pedido',
  description:
    'Registra o pedido no sistema e notifica o dono. So chame DEPOIS que o cliente ' +
    'confirmou o pedido completo (itens, endereco, pagamento). O CODIGO calcula ' +
    'subtotal, taxa e total a partir dos itens - voce so passa nome e quantidade. ' +
    'Se algum item nao existir no cardapio, a ferramenta devolve erro e voce ajusta.',
  input_schema: {
    type: 'object',
    properties: {
      cliente_nome: { type: 'string', description: 'Nome do cliente.' },
      cliente_telefone: {
        type: 'string',
        description:
          'Telefone de contato que o cliente informou para o entregador. Pode ser ' +
          'diferente do numero do WhatsApp. Aceita formato livre (o codigo normaliza), ' +
          'mas precisa ter pelo menos 8 digitos.',
      },
      itens: {
        type: 'array',
        description:
          'Lista de itens do pedido. Cada item precisa do NOME exato como aparece no cardapio.',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do item (igual ao cardapio).' },
            quantidade: { type: 'integer', description: 'Quantidade (>= 1).' },
            observacoes: {
              type: 'string',
              description: 'Observacoes deste item (ex.: "sem cebola"). Opcional.',
            },
          },
          required: ['nome', 'quantidade'],
        },
      },
      endereco: {
        type: 'string',
        description: 'Endereco completo: rua, numero, complemento (se houver).',
      },
      bairro: { type: 'string', description: 'Bairro da entrega.' },
      forma_pagamento: {
        type: 'string',
        description: 'Uma das formas aceitas (dinheiro, cartao na entrega, pix).',
      },
      troco_para: {
        type: 'number',
        description:
          'Se pagamento = dinheiro, valor para o qual precisa de troco. Omita se sem troco ou nao aplicavel.',
      },
      observacoes: {
        type: 'string',
        description: 'Observacoes gerais do pedido (opcional).',
      },
    },
    required: [
      'cliente_nome',
      'cliente_telefone',
      'itens',
      'endereco',
      'bairro',
      'forma_pagamento',
    ],
  },
};

const TOOLS = [
  TOOL_CONSULTAR_CARDAPIO,
  TOOL_VERIFICAR_HORARIO,
  TOOL_CONSULTAR_MEU_PEDIDO,
  TOOL_PASSAR_PARA_HUMANO,
  TOOL_REGISTRAR_PEDIDO,
];

// --- ANTI-VACUO ---
// Padroes que sinalizam "vou consultar depois" - o bot NAO tem depois. Se o modelo
// mandou algo assim SEM chamar ferramenta, o codigo forca uma nova iteracao com um
// lembrete. Faz isso NO MAXIMO 1x por resposta pra nao entrar em loop.
const PATTERNS_VACUO = [
  /\bum\s+momentinho\b/i,
  /\baguard[ea]\s+(um|so|so\s+um)/i,
  /\bdeixa\s+(eu|-me)\s+(ver|consultar|verificar|checar|olhar|pesquisar)/i,
  /\bvou\s+(consultar|verificar|checar|olhar|pesquisar|dar\s+uma\s+olhada|buscar|procurar)/i,
  /\bj[aá]\s+(te\s+)?(retorno|volto|aviso|respondo|falo)/i,
  /\bassim\s+que\s+(eu\s+)?(souber|descobrir|verificar)/i,
];
export function pareceVacuo(texto) {
  if (!texto) return false;
  return PATTERNS_VACUO.some((r) => r.test(texto));
}

// ---------- Calculo do pedido (CODIGO, nao modelo) ----------
// Recebe o input do tool_use "registrar_pedido" e devolve:
//   { ok: true, dados: { ...pedido calculado } }  para o core salvar
//   { ok: false, mensagem: '...' }                para voltar ao modelo como erro
// Nunca deixe o modelo somar precos.
export function calcularPedido(input) {
  if (!Array.isArray(input.itens) || input.itens.length === 0) {
    return { ok: false, mensagem: 'Pedido sem itens. Peca ao cliente o que ele quer.' };
  }

  // Telefone: exige pelo menos 8 digitos apos remover formatacao (celular tem 11,
  // fixo tem 10; 8 e o piso pra nao aceitar lixo).
  const telefoneDigitos = String(input.cliente_telefone || '').replace(/\D/g, '');
  if (telefoneDigitos.length < 8) {
    return {
      ok: false,
      mensagem:
        'Telefone do cliente ausente ou invalido. Peca de novo (com DDD ou pelo menos ' +
        '8 digitos) e confirme antes de registrar.',
    };
  }

  const itensCalc = [];
  for (const it of input.itens) {
    const encontrado = acharItemCardapio(it.nome);
    if (!encontrado) {
      return {
        ok: false,
        mensagem: `Item "${it.nome}" nao existe no cardapio. Chame consultar_cardapio e ajuste.`,
      };
    }
    if (encontrado.disponivel === false) {
      return {
        ok: false,
        mensagem: `Item "${encontrado.nome}" esta ESGOTADO. Ofereca outra coisa ao cliente.`,
      };
    }
    const qtd = Number(it.quantidade);
    if (!Number.isInteger(qtd) || qtd < 1) {
      return {
        ok: false,
        mensagem: `Quantidade invalida para "${it.nome}". Precisa ser inteiro >= 1.`,
      };
    }
    itensCalc.push({
      nome: encontrado.nome,
      quantidade: qtd,
      observacoes: it.observacoes || null,
      preco_unitario: encontrado.preco,
      subtotal: Number((encontrado.preco * qtd).toFixed(2)),
    });
  }

  const subtotal = Number(itensCalc.reduce((s, it) => s + it.subtotal, 0).toFixed(2));

  // Valor minimo do pedido (subtotal, sem taxa).
  const min = Number(CLIENTE.valorMinimoPedido || 0);
  if (subtotal < min) {
    return {
      ok: false,
      mensagem: `Subtotal ${formatarBRL(subtotal)} abaixo do minimo ${formatarBRL(min)}. Peca ao cliente para adicionar item.`,
    };
  }

  const taxa = Number(CLIENTE.taxaEntregaPadrao || 0);
  const total = Number((subtotal + taxa).toFixed(2));
  // Previsao de entrega: agora + tempo maximo estimado. Sera gravada junto com
  // o pedido no banco pelo salvarPedido; se o cliente voltar mais tarde perguntando
  // status, o bot usa esse valor para responder com hora real.
  const previsaoMs = Date.now() + tempoMedioEntregaMax() * 60 * 1000;

  return {
    ok: true,
    dados: {
      cliente_nome: input.cliente_nome || null,
      cliente_telefone: telefoneDigitos,
      itens: itensCalc,
      subtotal,
      taxa_entrega: taxa,
      total,
      endereco: input.endereco || null,
      bairro: input.bairro || null,
      forma_pagamento: input.forma_pagamento || null,
      troco_para: input.troco_para != null ? Number(input.troco_para) : null,
      observacoes: input.observacoes || null,
      previsao_entrega: previsaoMs,
    },
  };
}

// ---------- Loop principal ----------
// gerarResposta(historico, opcoes)
//  - opcoes.onPedido({ pedido }): chamado quando um pedido e registrado com sucesso.
//    Deve gravar o pedido e retornar { id, criado_em } (timestamp ms). Tambem deve
//    enviar o resumo ao dono.
//  - opcoes.onPassarHumano({ motivo }): chamado quando o modelo transfere para humano.
//  - opcoes.onConsultarMeuPedido(): retorna o ultimo pedido do contato (linha bruta
//    do banco) ou null. O core injeta o contactId.
export async function gerarResposta(historico, opcoes = {}) {
  if (MOCK) {
    return '[MOCK] Oi! Aqui e o atendente de teste (sem gastar API). O que voce vai querer?';
  }

  const system = montarSystemPrompt();

  const mensagens = historico.map((m) => ({ ...m }));
  let textoFinal = '';
  let jaRePromptouPorVacuo = false;
  const respostaPadrao = 'Certo! Me diga o que voce vai querer.';

  for (let i = 0; i < 6; i++) {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      tools: TOOLS,
      messages: mensagens,
    });

    const textos = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (textos) textoFinal = textos;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      if (!jaRePromptouPorVacuo && pareceVacuo(textos)) {
        console.warn('[anti-vacuo] resposta parece promessa sem tool_use - re-promptando');
        jaRePromptouPorVacuo = true;
        mensagens.push({ role: 'assistant', content: resp.content });
        mensagens.push({
          role: 'user',
          content:
            '[LEMBRETE INTERNO - o cliente NAO viu esta mensagem] Voce respondeu ' +
            'prometendo consultar/verificar, mas nao chamou nenhuma ferramenta. Chame ' +
            'AGORA a ferramenta apropriada (consultar_cardapio, verificar_horario_funcionamento, ' +
            'consultar_meu_pedido) e ja escreva a resposta ao cliente com o resultado, ' +
            'terminando com um proximo passo claro. Nao repita a frase de espera.',
        });
        continue;
      }
      break;
    }

    mensagens.push({ role: 'assistant', content: resp.content });

    const resultados = [];
    for (const tu of toolUses) {
      let conteudo = 'Operacao concluida.';

      if (tu.name === 'consultar_cardapio') {
        conteudo = formatarCardapio(tu.input?.categoria);
      } else if (tu.name === 'verificar_horario_funcionamento') {
        conteudo = formatarStatusHorario();
      } else if (tu.name === 'consultar_meu_pedido') {
        try {
          const ped =
            typeof opcoes.onConsultarMeuPedido === 'function'
              ? await opcoes.onConsultarMeuPedido()
              : null;
          if (!ped) {
            conteudo =
              'Nenhum pedido registrado para este cliente ainda. Se ele acha que ' +
              'fez pedido, pergunte quando/como para investigar (talvez foi por outro canal).';
          } else {
            const agora = Date.now();
            const atrasoMin = Math.round((agora - Number(ped.previsao_entrega || 0)) / 60000);
            const statusTempo =
              ped.previsao_entrega && agora > ped.previsao_entrega
                ? `PREVISAO ESTOURADA ha ${atrasoMin} min - pedido pode estar atrasado.`
                : ped.previsao_entrega
                  ? `Dentro do prazo (falta ${-atrasoMin} min).`
                  : 'Sem previsao registrada.';
            conteudo =
              `Pedido #${ped.id} | Status: ${ped.status}\n` +
              `Feito em: ${formatarDataBR(ped.criado_em)}\n` +
              `Previsao de entrega: ${formatarDataBR(ped.previsao_entrega)}\n` +
              `${statusTempo}\n` +
              `Total: ${formatarBRL(ped.total)} | Endereco: ${ped.endereco || '-'} - ${ped.bairro || '-'}\n` +
              `Diga ao cliente a HORA da previsao (nao "40 minutos" - hora real) e, ` +
              `se estourou, pece desculpas e ofereca passar para humano.`;
          }
        } catch (e) {
          console.error('Erro no onConsultarMeuPedido:', e?.message || e);
          conteudo = 'Nao consegui consultar o pedido agora.';
        }
      } else if (tu.name === 'passar_para_humano') {
        try {
          if (typeof opcoes.onPassarHumano === 'function') {
            await opcoes.onPassarHumano({ motivo: tu.input?.motivo || 'sem motivo informado' });
          }
          conteudo =
            'Transferido para atendimento humano. Diga ao cliente algo como "vou passar pro atendente humano, ' +
            'ele vai te responder em instantes" e ENCERRE a conversa (nao continue coletando pedido).';
        } catch (e) {
          console.error('Erro no onPassarHumano:', e?.message || e);
          conteudo = 'Nao consegui transferir agora. Pergunte de novo em instantes.';
        }
      } else if (tu.name === 'registrar_pedido') {
        console.log('[agent] modelo chamou registrar_pedido');
        const calc = calcularPedido(tu.input || {});
        if (!calc.ok) {
          console.warn(`[agent] calcularPedido REJEITOU: ${calc.mensagem}`);
          conteudo = `ERRO: ${calc.mensagem}`;
        } else {
          try {
            const salvo =
              typeof opcoes.onPedido === 'function'
                ? await opcoes.onPedido({ pedido: calc.dados })
                : null;
            const numero = salvo?.id ? `#${salvo.id}` : '';
            const previsaoStr = formatarDataBR(calc.dados.previsao_entrega);
            conteudo =
              `Pedido ${numero} registrado com sucesso. Subtotal ${formatarBRL(calc.dados.subtotal)}, ` +
              `taxa ${formatarBRL(calc.dados.taxa_entrega)}, TOTAL ${formatarBRL(calc.dados.total)}. ` +
              `Previsao de entrega: ${previsaoStr} (janela: ${CLIENTE.tempoMedioEntrega}). ` +
              `Confirme ao cliente com o NUMERO do pedido e a HORA prevista (nao so ` +
              `"40 minutos" - fale a hora real, tipo "chega ate as 21:15").`;
          } catch (e) {
            console.error('Erro no onPedido:', e?.message || e);
            conteudo = 'Erro ao registrar o pedido. Peca desculpas ao cliente e pergunte de novo.';
          }
        }
      }

      resultados.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: conteudo,
      });
    }
    mensagens.push({ role: 'user', content: resultados });
  }

  return textoFinal || respostaPadrao;
}
